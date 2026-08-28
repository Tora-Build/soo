//! `dispute` — guardian veto on an attested outcome.
//!
//! Callable while the market is `Locked` and the attestation is younger than
//! `VETO_PERIOD_SECS`. The veto REJECTS the ruling and hands the market back:
//! it clears the attestation, and the adjudicator must rule again — a fresh
//! attestation, a fresh veto window. The guardian's own claim about the
//! outcome rides the event as a public statement, but the guardian cannot
//! WRITE an outcome: rejecting and deciding are different powers, and this
//! instruction grants only the smaller one. (The previous design let the
//! veto override the outcome directly — strictly more power than a court of
//! appeal needs.)
//!
//! Capped at `MAX_DISPUTES` per entry so a guardian cannot filibuster a
//! market forever; a market whose adjudicator never re-rules is rescued by
//! the forced-invalid hatch like any other silence.
//!
//! The signer may be the entry's `dispute_authority` OR any member of the
//! market's `GuardianSet` (an optional side PDA — see state/guardians.rs).
//!
//! Reachable only because attest and settle are separate instructions — see
//! `attest_outcome`'s module docs.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::DisputeRaised;
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::adjudicator::MAX_DISPUTES;
use crate::state::{
    AdjudicatorEntry, GuardianSet, Market, MarketLifecycle, ProtocolConfig,
    ADJUDICATOR_ENTRY_SEED, GUARDIAN_SET_SEED,
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

    /// The deputized roster, when one exists. Optional: markets that never
    /// added guardians pass nothing and only the dispute authority may veto.
    #[account(
        seeds = [GUARDIAN_SET_SEED, market.key().as_ref()],
        bump = guardian_set.bump,
    )]
    pub guardian_set: Option<Account<'info, GuardianSet>>,

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
        ctx.accounts.adjudicator_entry.dispute_count < MAX_DISPUTES,
        SoothCoreError::TooManyDisputes
    );

    ctx.accounts
        .adjudicator_entry
        .require_named_dispute_authority()?;
    let disputer = ctx.accounts.disputer.key();
    let is_authority = disputer == ctx.accounts.adjudicator_entry.dispute_authority;
    let is_guardian = ctx
        .accounts
        .guardian_set
        .as_ref()
        .map(|set| set.contains(&disputer))
        .unwrap_or(false);
    require!(is_authority || is_guardian, SoothCoreError::Unauthorized);

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
        // The rejection: the ruling is GONE, not replaced. The adjudicator
        // re-attests (the `!is_attested()` gate reopens), and settlement
        // waits on the fresh attestation's own veto window. `new_outcome`
        // stays in the event below as the guardian's on-record claim.
        let entry = &mut ctx.accounts.adjudicator_entry;
        entry.attested_outcome = None;
        entry.attested_at = None;
        entry.disputed = true;
        entry.disputed_at = Some(now);
        entry.dispute_count += 1;
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
