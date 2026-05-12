use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::SoothMarketError;
use crate::instruction_introspection::{
    require_sooth_book_cpi_parent, SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
    SOOTH_BOOK_BUY_YES_DISCRIMINATOR, SOOTH_BOOK_CANCEL_BY_ID_DISCRIMINATOR,
    SOOTH_BOOK_CANCEL_DISCRIMINATOR,
};
use crate::state::Market;

#[derive(Accounts)]
pub struct WithdrawForOrder<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: derived via seeds; signs vault outflows.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault @ SoothMarketError::VaultAuthorityMismatch,
        constraint = vault.mint == crate::USDC_MINT_DEVNET
            @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault.mint)]
    pub to_usdc_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,

    /// CHECK: address-pinned and parsed by the parent-ix gate.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<WithdrawForOrder>, base_units: u64) -> Result<()> {
    require_sooth_book_cpi_parent(
        &ctx.accounts.instruction_sysvar,
        &[
            SOOTH_BOOK_BUY_YES_DISCRIMINATOR,
            SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
            SOOTH_BOOK_CANCEL_DISCRIMINATOR,
            SOOTH_BOOK_CANCEL_BY_ID_DISCRIMINATOR,
        ],
    )?;

    if base_units == 0 {
        return Ok(());
    }

    let market_id = ctx.accounts.market.market_id;
    let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.to_usdc_ata.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        base_units,
    )?;

    Ok(())
}
