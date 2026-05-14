//! `attest_outcome` — Manual variant. The per-market authority signs a
//! `winning_outcome`, which mutates AdjudicatorEntry state and calls
//! `settle_internal` to drive the market `Locked` → `Settled`.
//!
//! Adapted from `sooth_adjudicator::attest_outcome`. Changes:
//!   - CPI to `sooth_market::settle` replaced with direct call to
//!     `settle::settle_internal`.
//!   - `sooth_market_program` and `instruction_sysvar` removed.
//!   - `Adjudicator` + `AdjudicatorKind` replaced with `AdjudicatorEntry`
//!     (no kind field — v1 supports Manual variant only via this ix).
//!   - `market` seeds have no `seeds::program`.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::OutcomeAttested;
use crate::instructions::settle::settle_internal;
use crate::state::{AdjudicatorEntry, Market, ADJUDICATOR_ENTRY_SEED};

const OUTCOME_NO: u8 = 0;
const OUTCOME_YES: u8 = 1;
const OUTCOME_INVALID: u8 = 2;

#[derive(Accounts)]
pub struct AttestOutcome<'info> {
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

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<AttestOutcome>, winning_outcome: u8) -> Result<()> {
    require!(
        winning_outcome == OUTCOME_NO
            || winning_outcome == OUTCOME_YES
            || winning_outcome == OUTCOME_INVALID,
        SoothCoreError::InvalidOutcome
    );

    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.adjudicator_entry.authority,
        SoothCoreError::Unauthorized
    );

    require!(
        !ctx.accounts.adjudicator_entry.is_attested(),
        SoothCoreError::AlreadyAttested
    );

    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let adjudicator_entry_key = ctx.accounts.adjudicator_entry.key();

    {
        let entry = &mut ctx.accounts.adjudicator_entry;
        entry.attested_outcome = Some(winning_outcome);
        entry.attested_at = Some(now);
    }

    // Direct call — no CPI.
    settle_internal(&mut ctx.accounts.market, winning_outcome)?;

    emit!(OutcomeAttested {
        market: market_key,
        adjudicator_entry: adjudicator_entry_key,
        winning_outcome,
        ts: now,
    });

    Ok(())
}
