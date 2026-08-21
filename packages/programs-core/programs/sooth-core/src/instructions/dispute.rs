//! `dispute` — guardian veto on an attested outcome.
//!
//! Callable while the market is `Locked` and the attestation is younger than
//! `VETO_PERIOD_SECS`. It overrides the recorded outcome and marks the entry
//! disputed; it does NOT settle. `settle` still finalizes, so the lifecycle
//! changes in exactly one place.
//!
//! Reachable only because attest and settle are separate instructions — see
//! `attest_outcome`'s module docs.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::DisputeRaised;
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::{
    AdjudicatorEntry, Market, MarketLifecycle, ProtocolConfig, ADJUDICATOR_ENTRY_SEED,
};

#[derive(Accounts)]
pub struct Dispute<'info> {
    #[account(
        mut,
        seeds = [ADJUDICATOR_ENTRY_SEED, market.key().as_ref()],
        bump = adjudicator_entry.bump,
        constraint = adjudicator_entry.market == market.key()
            @ SoothCoreError::AmmStateMarketMismatch,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    /// Read-only: a veto changes the outcome, not the lifecycle.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub disputer: Signer<'info>,
}

pub fn handler(ctx: Context<Dispute>, new_outcome: u8) -> Result<()> {
    require!(
        new_outcome == OUTCOME_NO || new_outcome == OUTCOME_YES || new_outcome == OUTCOME_INVALID,
        SoothCoreError::InvalidOutcome
    );

    require!(
        !matches!(ctx.accounts.market.lifecycle, MarketLifecycle::Settled),
        SoothCoreError::MarketAlreadySettled
    );

    require!(
        ctx.accounts.adjudicator_entry.is_attested(),
        SoothCoreError::NotYetAttested
    );

    require!(
        !ctx.accounts.adjudicator_entry.is_disputed(),
        SoothCoreError::AlreadyDisputed
    );

    require_keys_eq!(
        ctx.accounts.disputer.key(),
        ctx.accounts.adjudicator_entry.dispute_authority,
        SoothCoreError::Unauthorized
    );

    let now = Clock::get()?.unix_timestamp;

    // The window itself. `attested_at` is Some whenever `is_attested()` holds,
    // which the guard above already established.
    let attested_at = ctx
        .accounts
        .adjudicator_entry
        .attested_at
        .ok_or(error!(SoothCoreError::NotYetAttested))?;
    let veto_ends_at = attested_at
        .checked_add(ctx.accounts.protocol_config.veto_period_secs)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    require!(now < veto_ends_at, SoothCoreError::VetoWindowClosed);
    let market_key = ctx.accounts.market.key();
    let adjudicator_entry_key = ctx.accounts.adjudicator_entry.key();
    let disputer_key = ctx.accounts.disputer.key();
    let previous_outcome = ctx
        .accounts
        .adjudicator_entry
        .attested_outcome
        .expect("attested_outcome verified in is_attested check above");

    {
        let entry = &mut ctx.accounts.adjudicator_entry;
        entry.attested_outcome = Some(new_outcome);
        entry.disputed = true;
        entry.disputed_at = Some(now);
    }

    emit!(DisputeRaised {
        market: market_key,
        adjudicator_entry: adjudicator_entry_key,
        disputer: disputer_key,
        previous_outcome,
        new_outcome,
        ts: now,
    });

    Ok(())
}
