//! `dispute` — veto branch on an attested outcome.
//!
//! Adapted from `sooth_adjudicator::dispute`. Changes:
//!   - CPI to `sooth_market::settle` replaced with direct call to
//!     `settle::settle_internal`.
//!   - `sooth_market_program` and `instruction_sysvar` removed.
//!   - `Adjudicator` replaced with `AdjudicatorEntry`.
//!   - `market` lifecycle check uses `crate::state::MarketLifecycle` directly.
//!   - `seeds::program` constraints removed.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::DisputeRaised;
use crate::instructions::settle::settle_internal;
use crate::state::{AdjudicatorEntry, Market, MarketLifecycle, ADJUDICATOR_ENTRY_SEED};

const OUTCOME_NO: u8 = 0;
const OUTCOME_YES: u8 = 1;
const OUTCOME_INVALID: u8 = 2;

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

    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

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

    // Direct call — no CPI.
    settle_internal(&mut ctx.accounts.market, new_outcome)?;

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
