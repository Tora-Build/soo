//! `attest_outcome` — Manual variant. The per-market authority signs a
//! `winning_outcome`, recording it on the `AdjudicatorEntry`.
//!
//! It does NOT settle. The market stays `Locked` and enters the ATTESTED
//! state for `VETO_PERIOD_SECS`, during which `dispute` may override the
//! outcome; after that window anyone may call `settle` to finalize.
//!
//! This used to call `settle_internal` inline, which made the `dispute`
//! handler unreachable: dispute requires both `is_attested()` and a
//! not-yet-`Settled` market, and collapsing attest+settle into one
//! transaction meant no market was ever in both states at once. Every
//! dispute failed with `MarketAlreadySettled` or `NotYetAttested`. See
//! `sdk-solana/tests/adjudicator-flow.test.ts`, which pins both branches.
//!
//! Splitting the phases is the remediation the spec already planned —
//! `docs/spec/sooth_adjudicator.md` §6 records the collapse as a
//! partial-conformance deviation (self-attested J1) whose fix is "separate
//! `resolve` and `attest` ix with veto window". It also matches the EVM
//! contract, where `resolve` and a permissionless `settle` are distinct
//! calls either side of `vetoEndsAt`.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::OutcomeAttested;
use crate::state::{AdjudicatorEntry, Market, MarketLifecycle, ADJUDICATOR_ENTRY_SEED};

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

    /// Read-only: attestation no longer changes the lifecycle. `settle` does
    /// that, after the veto window.
    #[account(
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

    // `settle_internal` used to enforce this via `can_transition_to`. With the
    // settle call removed, attestation must gate the lifecycle itself —
    // otherwise an Open market could be attested and would then settle
    // straight out of trading once the veto window elapsed.
    require!(
        matches!(ctx.accounts.market.lifecycle, MarketLifecycle::Locked),
        SoothCoreError::InvalidLifecycleTransition
    );

    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let adjudicator_entry_key = ctx.accounts.adjudicator_entry.key();

    {
        let entry = &mut ctx.accounts.adjudicator_entry;
        entry.attested_outcome = Some(winning_outcome);
        entry.attested_at = Some(now);
    }

    emit!(OutcomeAttested {
        market: market_key,
        adjudicator_entry: adjudicator_entry_key,
        winning_outcome,
        ts: now,
    });

    Ok(())
}
