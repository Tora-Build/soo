use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::SoothMarketError;
use crate::instruction_introspection::{
    require_sooth_book_cpi_parent, SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
    SOOTH_BOOK_BUY_YES_DISCRIMINATOR,
};
use crate::instructions::orderbook_common::require_before_deadline;
use crate::state::Market;

#[derive(Accounts)]
pub struct DepositForOrder<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        address = market.vault @ SoothMarketError::VaultAuthorityMismatch,
        constraint = vault.mint == crate::USDC_MINT_DEVNET
            @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault.mint, token::authority = from)]
    pub from_usdc_ata: Box<Account<'info, TokenAccount>>,

    pub from: Signer<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: address-pinned and parsed by the parent-ix gate.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<DepositForOrder>, base_units: u64) -> Result<()> {
    require_sooth_book_cpi_parent(
        &ctx.accounts.instruction_sysvar,
        &[
            SOOTH_BOOK_BUY_YES_DISCRIMINATOR,
            SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
        ],
    )?;
    require_before_deadline(&ctx.accounts.market)?;

    if base_units == 0 {
        return Ok(());
    }

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.from_usdc_ata.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.from.to_account_info(),
            },
        ),
        base_units,
    )?;

    Ok(())
}
