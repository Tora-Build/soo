//! `request_lock` — adjudicator-side entry point that transitions a market
//! from `Open` → `Locked`.
//!
//! Auth: `authority.key() == adjudicator_entry.authority`.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::state::{AdjudicatorEntry, Market, MarketLifecycle, ADJUDICATOR_ENTRY_SEED};

#[derive(Accounts)]
pub struct RequestLock<'info> {
    #[account(
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

pub fn handler(ctx: Context<RequestLock>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.adjudicator_entry.authority,
        SoothCoreError::Unauthorized
    );

    let market = &mut ctx.accounts.market;
    require!(
        matches!(market.lifecycle, MarketLifecycle::Open),
        SoothCoreError::MarketNotOpen
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now >= market.deadline, SoothCoreError::TradingNotClosed);

    market.lifecycle = MarketLifecycle::Locked;

    Ok(())
}
