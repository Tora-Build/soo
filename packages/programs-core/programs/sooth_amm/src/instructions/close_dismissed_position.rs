//! `close_dismissed_position` -- close a refunded Position after dismissal.
//!
//! This is intentionally a no-token-movement helper. The user-facing
//! `sooth_market::claim_refund` ix transfers the tracked locked cost out of
//! the market vault, then CPIs here to close the AMM-owned Position account
//! and refund rent to the user. Parent-ix introspection rejects direct calls
//! that try to close a Position without routing through the market-side
//! refund transfer.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;

use crate::error::SoothAmmError;
use crate::state::{AmmState, Market, Position};

const CLAIM_REFUND_DISCRIMINATOR: [u8; 8] = [15, 16, 30, 161, 255, 228, 97, 60];

#[derive(Accounts)]
pub struct CloseDismissedPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Account<'info, Market>,

    #[account(
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        constraint = amm_state.market == market.key() @ SoothAmmError::AmmStateMarketMismatch,
    )]
    pub amm_state: Account<'info, AmmState>,

    #[account(
        mut,
        seeds = [b"pos", market.market_id.as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = user @ SoothAmmError::Unauthorized,
        has_one = market @ SoothAmmError::Unauthorized,
        close = user,
    )]
    pub position: Account<'info, Position>,

    /// Instructions sysvar, used to require a `sooth_market::claim_refund`
    /// parent ix in the current top-level instruction slot.
    /// CHECK: address-pinned.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<CloseDismissedPosition>) -> Result<()> {
    require_claim_refund_parent(&ctx.accounts.instruction_sysvar)?;
    require!(
        ctx.accounts.amm_state.is_dismissed,
        SoothAmmError::MarketNotDismissed
    );
    Ok(())
}

fn require_claim_refund_parent(instruction_sysvar: &AccountInfo) -> Result<()> {
    let current_index = ix_sysvar::load_current_index_checked(instruction_sysvar)? as usize;

    for i in 0..=current_index {
        let ix = ix_sysvar::load_instruction_at_checked(i, instruction_sysvar)?;
        if ix.program_id == sooth_market::ID
            && ix.data.len() >= 8
            && ix.data[..8] == CLAIM_REFUND_DISCRIMINATOR
        {
            return Ok(());
        }
    }

    Err(error!(SoothAmmError::InvalidParentInstruction))
}
