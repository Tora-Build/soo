//! `dismiss_market` — creator flips AmmState.is_dismissed after trial window.
//!
//! Adapted from `sooth_amm::dismiss_market`. No `seeds::program` needed.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::MarketDismissed;
use crate::state::{AmmState, Market};

#[derive(Accounts)]
pub struct DismissMarket<'info> {
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        constraint = amm_state.market == market.key() @ SoothCoreError::AmmStateMarketMismatch,
    )]
    pub amm_state: Account<'info, AmmState>,

    #[account(constraint = creator.key() == market.creator @ SoothCoreError::Unauthorized)]
    pub creator: Signer<'info>,
}

pub fn handler(ctx: Context<DismissMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let amm = &mut ctx.accounts.amm_state;

    require!(now >= amm.trial_end_at, SoothCoreError::TrialNotExpired);
    require!(!amm.is_graduated, SoothCoreError::AlreadyGraduated);
    require!(!amm.is_dismissed, SoothCoreError::AlreadyDismissed);

    amm.is_dismissed = true;
    emit!(MarketDismissed {
        market: amm.market,
        creator: ctx.accounts.creator.key(),
        dismissed_at: now,
    });
    Ok(())
}
