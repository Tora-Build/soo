//! `mint_complete_set` — pull `amount` USDC from user, mint `amount` YES +
//! `amount` NO into user outcome ATAs.
//!
//! EVM analogue: `OrderEngine._mint` (`OrderEngine.sol:680-694`):
//!
//! ```solidity
//! baseToken.safeTransferFrom(user, address(this), collateralIn);
//! _collateralBacking[market] += collateralIn;
//! _positions[market][user].yesShares += amount;
//! _positions[market][user].noShares  += amount;
//! ```
//!
//! On Solana the "position storage" is replaced by SPL outcome tokens — the
//! user's wallet ATAs are the source of truth, redeemable directly against
//! the vault at settlement.
//!
//! Used by:
//!   - SDK directly (deposit-into-shares path).
//!   - `sooth_amm` to bootstrap shares for AMM trades (CPI from
//!     `trade_positions` once we wire vault custody — see the trade_positions
//!     "STUB" comment).
//!   - `sooth_book` orderbook taker path for the maker-not-escrowed branch
//!     (it pulls USDC and produces both legs, then credits one side and
//!     keeps the other in the resting-order ledger).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::error::SoothMarketError;
use crate::events::CompleteSetMinted;
use crate::state::Market;

#[derive(Accounts)]
pub struct MintCompleteSet<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// Vault authority PDA — signs the mint_to CPIs.
    /// CHECK: derived via seeds.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.yes_mint @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = market.no_mint @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    /// Market USDC vault. Constraint pin: must match the address stored on
    /// `Market` at init time. H1 (Codex): the canonical-USDC pin lives on
    /// `initialize_market_vaults::usdc_mint` (`address = USDC_MINT_DEVNET`),
    /// and the vault was created at that ix as ATA-of-`vault_authority` with
    /// `associated_token::mint = usdc_mint`, so `vault.mint` is transitively
    /// bound to `USDC_MINT_DEVNET` here — the `token::mint = vault.mint`
    /// constraint on the user ATA below therefore pins the user side too.
    #[account(
        mut,
        address = market.vault @ SoothMarketError::VaultAuthorityMismatch,
        constraint = vault.mint == crate::USDC_MINT_DEVNET
            @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// User's USDC ATA — debited.
    #[account(mut, token::mint = vault.mint, token::authority = user)]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's YES outcome-token ATA — credited.
    #[account(mut, token::mint = yes_mint, token::authority = user)]
    pub user_yes_ata: Box<Account<'info, TokenAccount>>,

    /// User's NO outcome-token ATA — credited.
    #[account(mut, token::mint = no_mint, token::authority = user)]
    pub user_no_ata: Box<Account<'info, TokenAccount>>,

    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<MintCompleteSet>, amount: u64) -> Result<()> {
    require!(amount > 0, SoothMarketError::ZeroAmount);
    require!(
        ctx.accounts.market.is_open(),
        SoothMarketError::MarketNotOpen
    );

    let market_id = ctx.accounts.market.market_id;
    let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

    // ── 1. USDC: user → vault ────────────────────────────────────────────
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

    // ── 2. Mint YES → user_yes_ata, signed by vault_authority PDA ────────
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.yes_mint.to_account_info(),
                to: ctx.accounts.user_yes_ata.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // ── 3. Mint NO → user_no_ata, signed by vault_authority PDA ──────────
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.no_mint.to_account_info(),
                to: ctx.accounts.user_no_ata.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    let now = Clock::get()?.unix_timestamp;
    emit!(CompleteSetMinted {
        market: ctx.accounts.market.key(),
        user: ctx.accounts.user.key(),
        amount_usdc: amount,
        ts: now,
    });

    Ok(())
}
