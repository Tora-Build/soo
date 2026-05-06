//! `initialize_market_vaults` — third leg of the create-market flow.
//!
//! Creates only the USDC vault + lock-vault ATAs, then flips the market
//! lifecycle from `Initializing` → `Open`. The two SPL Mints (`yes_mint`,
//! `no_mint`) are created in the second leg `initialize_outcome_mints`.
//!
//! Splitting the SPL leg into mints-then-ATAs (rather than co-init in one
//! ix) is forced by Anchor 0.30.1's `try_accounts` codegen: even with every
//! `Account<'info, T>` boxed, four SPL inits in one ix overflow the SBF
//! 4 KB stack frame (~6 KB observed with mints + ATAs together; ~5.4 KB
//! with mints alone; ~4 KB with ATAs alone). See the matching note in
//! `initialize_market.rs`.
//!
//! ## Accounts created
//!
//! - `vault`      USDC ATA   owner = `vault_authority` PDA
//! - `lock_vault` USDC ATA   owner = `lock_authority` PDA
//!
//! Pre-existing (read+modified):
//! - `market`     Market PDA — flips lifecycle from `Initializing` → `Open`
//!                             and stores the `vault` / `lock_vault` ATAs.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::SoothMarketError;
use crate::state::{Market, MarketLifecycle};

#[derive(Accounts)]
pub struct InitializeMarketVaults<'info> {
    /// Existing Market PDA — must be in `Initializing`. Bumps were pinned at
    /// `initialize_market`; we re-derive seeds here to validate the address.
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        has_one = creator @ SoothMarketError::VaultAuthorityMismatch,
        constraint = matches!(market.lifecycle, MarketLifecycle::Initializing)
            @ SoothMarketError::InvalidLifecycleTransition,
        // Outcome mints must already exist (created by
        // `initialize_outcome_mints`). The address pin is enough; we don't
        // need to deserialize them, hence no `Account<'info, Mint>` field.
        constraint = market.yes_mint != Pubkey::default()
            @ SoothMarketError::InvalidLifecycleTransition,
    )]
    pub market: Box<Account<'info, Market>>,

    /// Signer-only PDA. Owner of the USDC vault ATA. CHECK: derived via
    /// seeds; safe.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Signer-only PDA. Owner of the lock-vault ATA. CHECK: derived via
    /// seeds; safe.
    #[account(
        seeds = [b"lock", market.market_id.as_ref()],
        bump = market.lock_authority_bump,
    )]
    pub lock_authority: UncheckedAccount<'info>,

    /// USDC mint reference. Pinned by the SDK to canonical mainnet USDC
    /// (`EPjFW...`) or the cluster-appropriate devnet faucet equivalent.
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// Market USDC vault — created as the ATA of `vault_authority`.
    #[account(
        init,
        payer = creator,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// AMM lock-on-sell escrow vault. See `lock_vault` placement note in
    /// `state/market.rs` and architecture §4.3.
    #[account(
        init,
        payer = creator,
        associated_token::mint = usdc_mint,
        associated_token::authority = lock_authority,
    )]
    pub lock_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<InitializeMarketVaults>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.vault = ctx.accounts.vault.key();
    market.lock_vault = ctx.accounts.lock_vault.key();
    market.lifecycle = MarketLifecycle::Open;

    Ok(())
}
