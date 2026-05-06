//! `initialize_outcome_mints` — second leg of the create-market flow.
//!
//! Creates the YES + NO outcome SPL mints. Split out from `initialize_market`
//! and `initialize_market_vaults` so the generated `try_accounts` frame for
//! each ix stays under the SBF 4 KB stack-frame ceiling. See the file-level
//! comment in `initialize_market.rs` for the Anchor-codegen rationale.
//!
//! ## Accounts created
//!
//! - `yes_mint`  SPL Mint   seeds = `[b"mint", market_id, b"y"]`,
//!                          mint_authority = `vault_authority` PDA, decimals = 6
//! - `no_mint`   SPL Mint   seeds = `[b"mint", market_id, b"n"]`,
//!                          mint_authority = `vault_authority` PDA, decimals = 6
//!
//! Pre-existing:
//! - `market`    Market PDA — must be in `Initializing` and the mints must
//!                            not yet have been created (yes_mint == default
//!                            on the Market record per the leg-1 contract).

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};

use crate::error::SoothMarketError;
use crate::state::{Market, MarketLifecycle};

#[derive(Accounts)]
pub struct InitializeOutcomeMints<'info> {
    /// Existing Market PDA — must be in `Initializing` and the outcome mints
    /// must still be unpopulated (yes_mint == default()).
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        has_one = creator @ SoothMarketError::VaultAuthorityMismatch,
        constraint = matches!(market.lifecycle, MarketLifecycle::Initializing)
            @ SoothMarketError::InvalidLifecycleTransition,
    )]
    pub market: Box<Account<'info, Market>>,

    /// Signer-only PDA. Mint authority for both outcome mints. CHECK:
    /// derived via seeds; safe.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = creator,
        seeds = [b"mint", market.market_id.as_ref(), b"y"],
        bump,
        mint::decimals = 6,
        mint::authority = vault_authority,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        seeds = [b"mint", market.market_id.as_ref(), b"n"],
        bump,
        mint::decimals = 6,
        mint::authority = vault_authority,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<InitializeOutcomeMints>) -> Result<()> {
    // The mint addresses + bumps were pinned on Market at `initialize_market`
    // via `Pubkey::find_program_address`. Re-validate here against the freshly
    // init'd accounts so a divergence is caught immediately.
    let market = &mut ctx.accounts.market;
    require!(
        ctx.bumps.yes_mint == market.yes_mint_bump,
        SoothMarketError::VaultAuthorityMismatch
    );
    require!(
        ctx.bumps.no_mint == market.no_mint_bump,
        SoothMarketError::VaultAuthorityMismatch
    );
    require!(
        ctx.accounts.yes_mint.key() == market.yes_mint,
        SoothMarketError::VaultAuthorityMismatch
    );
    require!(
        ctx.accounts.no_mint.key() == market.no_mint,
        SoothMarketError::VaultAuthorityMismatch
    );
    // No state mutation here — the mints existing IS the state change.
    // `initialize_market_vaults` is the ix that flips lifecycle to Open.

    Ok(())
}
