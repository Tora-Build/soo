//! `init_market_fee_pool` — create the per-market fee plumbing: two fee
//! pools AND two LP yield vaults, one of each per venue.
//!
//! An SPL token account holds exactly one mint, so the AMM's money (its own
//! token) and the book's (USDC) physically cannot share accounts. All four
//! are created in one instruction so a market cannot end up with half its
//! plumbing.
//!
//! ## Why the yield vaults are PER-MARKET
//!
//! They were not, and that was a cross-market theft. `lp_yield_authority` is
//! a global singleton, so "the ATA of that authority for the AMM mint" was
//! ONE account for the whole protocol — every market's `distribute_fees`
//! paid into it, and `redeem_lp` paid out `global_vault × lp / THIS market's
//! supply`. The sole LP of a dust market could burn 100% of a supply of one
//! and take every other market's accumulated yield; first to redeem won.
//! Seeding the vaults by `market_id` makes each market's yield claimable
//! only against its own LP supply.

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

    /// CHECK: signer-only PDA — authority on the per-market LP yield vaults.
    #[account(seeds = [b"lp_yield_authority"], bump)]
    pub lp_yield_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = signer,
        seeds = [b"lp_yield_amm", market.market_id.as_ref()],
        bump,
        token::mint = amm_mint,
        token::authority = lp_yield_authority,
    )]
    pub lp_yield_amm: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = signer,
        seeds = [b"lp_yield_book", market.market_id.as_ref()],
        bump,
        token::mint = book_mint,
        token::authority = lp_yield_authority,
    )]
    pub lp_yield_book: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(_ctx: Context<InitMarketFeePool>) -> Result<()> {
    Ok(())
}
