//! `lock_for_resolution` — halt trading; market enters Locked state pending
//! adjudicator outcome.
//!
//! Auth is via `AdjudicatorEntry` directly — the signer must be
//! `adjudicator_entry.authority`.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::MarketLocked;
use crate::state::{AdjudicatorEntry, Market, MarketLifecycle, ADJUDICATOR_ENTRY_SEED};

#[derive(Accounts)]
pub struct LockForResolution<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// Per-market adjudicator record. Bound to `market` via seed derivation.
    #[account(
        seeds = [ADJUDICATOR_ENTRY_SEED, market.key().as_ref()],
        bump = adjudicator_entry.bump,
        constraint = adjudicator_entry.market == market.key()
            @ SoothCoreError::AdjudicatorMarketMismatch,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    /// Authority that may request a lock. Must be `adjudicator_entry.authority`.
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<LockForResolution>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.adjudicator_entry.authority,
        SoothCoreError::NotAuthority
    );

    let market = &mut ctx.accounts.market;
    require!(
        market.lifecycle.can_transition_to(MarketLifecycle::Locked),
        SoothCoreError::InvalidLifecycleTransition
    );
    market.lifecycle = MarketLifecycle::Locked;

    let now = Clock::get()?.unix_timestamp;
    emit!(MarketLocked {
        market: market.key(),
        ts: now,
    });

    Ok(())
}
