//! `mint_complete_set_for_orderbook` — pull USDC from user, credit shares
//! to the user's `OrderbookPosition` (no SPL outcome tokens minted).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::BASE_TOKEN_MINT;

use crate::error::SoothCoreError;
use crate::events::CompleteSetMinted;
use crate::instructions::orderbook_common::{
    base_to_wad, credit_shares, ensure_position_identity, require_before_deadline,
};
use crate::state::{Market, OrderbookPosition};

#[derive(Accounts)]
pub struct MintCompleteSetForOrderbook<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init_if_needed,
        payer = user,
        space = OrderbookPosition::SPACE,
        seeds = [b"orderbook_position", market.market_id.as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, OrderbookPosition>>,

    #[account(
        mut,
        address = market.vault @ SoothCoreError::VaultAuthorityMismatch,
        constraint = vault.mint == BASE_TOKEN_MINT
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault.mint, token::authority = user)]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<MintCompleteSetForOrderbook>, amount: u64) -> Result<()> {
    require!(amount > 0, SoothCoreError::ZeroAmount);
    require_before_deadline(&ctx.accounts.market)?;

    ensure_position_identity(
        &mut ctx.accounts.position,
        ctx.accounts.market.key(),
        ctx.accounts.user.key(),
    )?;
    let shares_wad = base_to_wad(amount)?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc_ata.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    credit_shares(&mut ctx.accounts.position, 1, shares_wad)?;
    credit_shares(&mut ctx.accounts.position, 0, shares_wad)?;

    emit!(CompleteSetMinted {
        market: ctx.accounts.market.key(),
        user: ctx.accounts.user.key(),
        amount_usdc: amount,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
