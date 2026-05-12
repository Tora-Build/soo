//! `transfer_fee_to_market_pool_from_book` -- PDA-signed USDC transfer
//! `market_vault -> market_fee_pool`.
//!
//! Helper for `sooth_book::{buy_yes,buy_no}` accumulator flushes. This is a
//! sibling of the AMM sell-fee helper, but uses the SoothBook single-load
//! parent gate so unrelated earlier ixs in the same transaction cannot
//! authorize the transfer.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::SoothMarketError;
use crate::instruction_introspection::{
    require_sooth_book_cpi_parent, SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
    SOOTH_BOOK_BUY_YES_DISCRIMINATOR,
};
use crate::state::{Market, MarketLifecycle};
use crate::USDC_MINT_DEVNET;

#[derive(Accounts)]
pub struct TransferFeeToMarketPoolFromBook<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        constraint = matches!(market.lifecycle, MarketLifecycle::Open)
            @ SoothMarketError::MarketNotOpen,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        address = market.vault @ SoothMarketError::VaultAuthorityMismatch,
        constraint = market_vault.mint == USDC_MINT_DEVNET
            @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"market_fee_pool", market.market_id.as_ref()],
        bump,
        seeds::program = sooth_protocol_types::SOOTH_LAUNCHPAD_PROGRAM_ID,
        constraint = market_fee_pool.mint == USDC_MINT_DEVNET
            @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub market_fee_pool: Box<Account<'info, TokenAccount>>,

    /// Vault authority signer-only PDA owned by `sooth_market`.
    /// CHECK: derived via seeds.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Instructions sysvar for the SoothBook buy parent-ix gate.
    /// CHECK: address-pinned.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<TransferFeeToMarketPoolFromBook>, amount: u64) -> Result<()> {
    require_sooth_book_cpi_parent(
        &ctx.accounts.instruction_sysvar,
        &[
            SOOTH_BOOK_BUY_YES_DISCRIMINATOR,
            SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
        ],
    )?;

    if amount == 0 {
        return Ok(());
    }

    let market_id = ctx.accounts.market.market_id;
    let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.market_vault.to_account_info(),
                to: ctx.accounts.market_fee_pool.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    Ok(())
}
