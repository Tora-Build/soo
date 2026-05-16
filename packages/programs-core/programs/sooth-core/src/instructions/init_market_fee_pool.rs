//! `init_market_fee_pool` — create the per-market USDC fee-pool token account.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::Market;

#[derive(Accounts)]
pub struct InitMarketFeePool<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: signer-only PDA — authority on every per-market fee-pool token account.
    #[account(
        seeds = [b"fee_pool_authority"],
        bump,
    )]
    pub fee_pool_authority: UncheckedAccount<'info>,

    #[account(address = crate::constants::BASE_TOKEN_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = signer,
        seeds = [b"market_fee_pool", market.market_id.as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = fee_pool_authority,
    )]
    pub market_fee_pool: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(_ctx: Context<InitMarketFeePool>) -> Result<()> {
    Ok(())
}
