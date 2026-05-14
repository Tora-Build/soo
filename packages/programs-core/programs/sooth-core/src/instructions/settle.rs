//! `settle` — finalize a Locked market with the adjudicator's winning outcome.
//!
//! Adapted from `sooth_market::settle`. Parent-ix introspection removed.
//! This is called directly from `attest_outcome` and `dispute` (both in the
//! same program), so the signer is the adjudicator `authority`.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::MarketSettled;
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::{AdjudicatorEntry, Market, MarketLifecycle, ADJUDICATOR_ENTRY_SEED};

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// Per-market adjudicator record. Used to authenticate the caller.
    #[account(
        seeds = [ADJUDICATOR_ENTRY_SEED, market.key().as_ref()],
        bump = adjudicator_entry.bump,
        constraint = adjudicator_entry.market == market.key()
            @ SoothCoreError::AdjudicatorMarketMismatch,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    /// Must be `adjudicator_entry.authority` (normal path) or
    /// `adjudicator_entry.dispute_authority` (dispute path). The caller
    /// (`attest_outcome` or `dispute`) enforces which key is appropriate.
    pub authority: Signer<'info>,
}

/// Internal settle helper — called by `attest_outcome` and `dispute`.
///
/// Skips the separate auth check; callers must validate `authority` before
/// calling this.
pub fn settle_internal(market: &mut Market, winning_outcome: u8) -> Result<()> {
    require!(
        winning_outcome == OUTCOME_NO
            || winning_outcome == OUTCOME_YES
            || winning_outcome == OUTCOME_INVALID,
        SoothCoreError::InvalidOutcome
    );
    require!(
        market.lifecycle.can_transition_to(MarketLifecycle::Settled),
        SoothCoreError::InvalidLifecycleTransition
    );
    market.lifecycle = MarketLifecycle::Settled;
    market.winning_outcome = winning_outcome;
    Ok(())
}

pub fn handler(ctx: Context<Settle>, winning_outcome: u8) -> Result<()> {
    require!(
        winning_outcome == OUTCOME_NO
            || winning_outcome == OUTCOME_YES
            || winning_outcome == OUTCOME_INVALID,
        SoothCoreError::InvalidOutcome
    );

    // Auth: authority must be the registered adjudicator authority.
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.adjudicator_entry.authority,
        SoothCoreError::NotAuthority
    );

    let market = &mut ctx.accounts.market;
    require!(
        market.lifecycle.can_transition_to(MarketLifecycle::Settled),
        SoothCoreError::InvalidLifecycleTransition
    );
    market.lifecycle = MarketLifecycle::Settled;
    market.winning_outcome = winning_outcome;

    let now = Clock::get()?.unix_timestamp;
    emit!(MarketSettled {
        market: market.key(),
        winning_outcome,
        ts: now,
    });

    Ok(())
}
