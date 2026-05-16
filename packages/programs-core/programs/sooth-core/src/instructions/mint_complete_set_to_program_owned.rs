//! `mint_complete_set_to_program_owned` — pull USDC from payer, mint YES + NO
//! into accounts owned by a separate destination authority.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::constants::BASE_TOKEN_MINT;

use crate::error::SoothCoreError;
use crate::events::CompleteSetMinted;
use crate::state::Market;

#[derive(Accounts)]
pub struct MintCompleteSetToProgramOwned<'info> {
    #[account(
        mut,
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
        address = market.yes_mint @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = market.no_mint @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(address = BASE_TOKEN_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = market.vault @ SoothCoreError::VaultAuthorityMismatch,
        token::mint = usdc_mint,
        token::authority = vault_authority,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = usdc_mint, token::authority = payer)]
    pub payer_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: holder authority only; token-account constraints below bind it.
    pub destination_authority: AccountInfo<'info>,

    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = destination_authority,
    )]
    pub destination_yes_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = no_mint,
        token::authority = destination_authority,
    )]
    pub destination_no_ata: Box<Account<'info, TokenAccount>>,

    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<MintCompleteSetToProgramOwned>, amount: u64) -> Result<()> {
    require!(amount > 0, SoothCoreError::ZeroAmount);
    require!(
        ctx.accounts.market.is_open(),
        SoothCoreError::MarketNotOpen
    );

    let market_id = ctx.accounts.market.market_id;
    let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.payer_usdc_ata.to_account_info(),
                to: ctx.accounts.market_vault.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(),
            },
        ),
        amount,
    )?;

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.yes_mint.to_account_info(),
                to: ctx.accounts.destination_yes_ata.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.no_mint.to_account_info(),
                to: ctx.accounts.destination_no_ata.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    let now = Clock::get()?.unix_timestamp;
    emit!(CompleteSetMinted {
        market: ctx.accounts.market.key(),
        user: ctx.accounts.payer.key(),
        amount_usdc: amount,
        ts: now,
    });

    Ok(())
}
