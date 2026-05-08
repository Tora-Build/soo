//! dismiss_market — creator flips AmmState.is_dismissed after the
//! trial window closes without graduation. Architecture §9.
//!
//! Gates:
//!   1. Clock::unix_timestamp >= amm_state.trial_end_at
//!   2. !amm_state.is_graduated     (graduated markets stay live)
//!   3. !amm_state.is_dismissed     (one-shot)
//!   4. signer == market.creator    (only the original creator)
//!
//! Effect: is_dismissed = true. No token movement — refunds happen
//! per-user via claim_refund (T61).

use anchor_lang::prelude::*;

use crate::error::SoothAmmError;
use crate::events::MarketDismissed;
use crate::state::{AmmState, Market};

#[derive(Accounts)]
pub struct DismissMarket<'info> {
    /// Market PDA — read-only. Creator pubkey is read from here.
    pub market: Account<'info, Market>,

    /// AmmState PDA — mutable, the dismissal flag flips on this account.
    #[account(
        mut,
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        constraint = amm_state.market == market.key() @ SoothAmmError::AmmStateMarketMismatch,
    )]
    pub amm_state: Account<'info, AmmState>,

    /// Creator must sign — matches Market.creator (gate #4).
    #[account(constraint = creator.key() == market.creator @ SoothAmmError::Unauthorized)]
    pub creator: Signer<'info>,
}

pub fn handler(ctx: Context<DismissMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let amm = &mut ctx.accounts.amm_state;

    require!(now >= amm.trial_end_at, SoothAmmError::TrialNotExpired);
    require!(!amm.is_graduated, SoothAmmError::AlreadyGraduated);
    require!(!amm.is_dismissed, SoothAmmError::AlreadyDismissed);

    amm.is_dismissed = true;
    emit!(MarketDismissed {
        market: amm.market,
        creator: ctx.accounts.creator.key(),
        dismissed_at: now,
    });
    Ok(())
}
