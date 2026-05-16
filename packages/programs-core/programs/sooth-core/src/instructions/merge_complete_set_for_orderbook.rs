//! `merge_complete_set_for_orderbook` — debit shares from OrderbookPosition,
//! return USDC to user.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::BASE_TOKEN_MINT;

use crate::error::SoothCoreError;
use crate::events::CompleteSetMerged;
use crate::instructions::orderbook_common::{base_to_wad, debit_shares, ensure_position_identity};
use crate::state::{Market, OrderbookPosition};

#[derive(Accounts)]
pub struct MergeCompleteSetForOrderbook<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: derived via seeds.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
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

    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<MergeCompleteSetForOrderbook>, amount: u64) -> Result<()> {
    require!(amount > 0, SoothCoreError::ZeroAmount);
    require!(
        ctx.accounts.market.is_open(),
        SoothCoreError::MarketNotOpen
    );

    ensure_position_identity(
        &mut ctx.accounts.position,
        ctx.accounts.market.key(),
        ctx.accounts.user.key(),
    )?;
    let shares_wad = base_to_wad(amount)?;
    debit_shares(&mut ctx.accounts.position, 1, shares_wad)?;
    debit_shares(&mut ctx.accounts.position, 0, shares_wad)?;

    let market_id = ctx.accounts.market.market_id;
    let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_usdc_ata.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    emit!(CompleteSetMerged {
        market: ctx.accounts.market.key(),
        user: ctx.accounts.user.key(),
        amount_usdc: amount,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
