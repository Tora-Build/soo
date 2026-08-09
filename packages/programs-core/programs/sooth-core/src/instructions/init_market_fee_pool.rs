//! `init_market_fee_pool` — create BOTH per-market fee-pool token accounts.
//!
//! One per venue. An SPL token account holds exactly one mint, so the AMM's
//! fees (its own token) and the book's (USDC) physically cannot share an
//! account. Both are created in one instruction so a market cannot end up with
//! only half its fee plumbing.

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

    #[account(address = crate::constants::BOOK_TOKEN_MINT)]
    pub book_mint: Box<Account<'info, Mint>>,

    #[account(address = crate::constants::AMM_TOKEN_MINT)]
    pub amm_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = signer,
        seeds = [b"fee_pool_book", market.market_id.as_ref()],
        bump,
        token::mint = book_mint,
        token::authority = fee_pool_authority,
    )]
    pub fee_pool_book: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = signer,
        seeds = [b"fee_pool_amm", market.market_id.as_ref()],
        bump,
        token::mint = amm_mint,
        token::authority = fee_pool_authority,
    )]
    pub fee_pool_amm: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(_ctx: Context<InitMarketFeePool>) -> Result<()> {
    Ok(())
}
