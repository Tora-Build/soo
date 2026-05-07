//! `transfer_to_lock` — PDA-signed USDC transfer `vault → lock_vault`.
//!
//! Wave 1B helper for `sooth_amm::sell_positions`. Both `vault_authority`
//! and `lock_authority` PDAs are derived under `sooth_market::ID` (set up by
//! `initialize_market_vaults`), so only `sooth_market` can `invoke_signed`
//! against them. The original Wave 1A `sell_positions` ix tried to sign for
//! `vault_authority` from inside `sooth_amm`, which the runtime rejects with
//! "Cross-program invocation with unauthorized signer or writable account"
//! because the seeds derive a *different* PDA under `sooth_amm::ID`.
//!
//! ## Auth model
//!
//! Two layered gates:
//!
//!   1. **User signature** — `user: Signer` re-checks the outer `sell_positions`
//!      signer flowed down through the CPI. Combined with the position
//!      validation below this means the caller controls the underlying
//!      Position.
//!   2. **Parent-ix introspection** — the runtime's `Instructions` sysvar is
//!      walked to confirm one of the preceding top-level ixs is from
//!      `sooth_amm` with the `sell_positions` discriminator. This closes
//!      the solvency hole where a user could call `transfer_to_lock`
//!      directly to move USDC `vault → lock_vault` without producing a
//!      `LockEntry` (which only `sell_positions` can mint). See
//!      `instruction_introspection.rs` for the full mechanism.
//!
//! Position-shape checks remain belt-and-braces:
//!
//!   1. `position.owner == sooth_amm::ID` (manual check — Position is owned
//!      by `sooth_amm`, not `sooth_market`, so we can't use a typed
//!      `Account<'info, Position>` without circular path-deps).
//!   2. `position.user == user.key()` (manual offset parse).
//!   3. `position.market == market.key()` (manual offset parse).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothMarketError;
use crate::instruction_introspection::{require_parent_ix, SELL_POSITIONS_DISCRIMINATOR};
use crate::state::{Market, MarketLifecycle};
use crate::SOOTH_AMM_PROGRAM_ID;

// Position account layout — sourced from `sooth-account-offsets` (see
// crate-level docstring). The compile-time assertion in
// `sooth_amm::state::position` ties `POSITION_TOTAL_LEN` to the live
// `Position::SPACE`, so any drift here trips the build of `sooth_amm`.
use sooth_account_offsets::{
    POSITION_MARKET_OFFSET, POSITION_TOTAL_LEN as POSITION_MIN_LEN, POSITION_USER_OFFSET,
};

#[derive(Accounts)]
pub struct TransferToLock<'info> {
    /// Market PDA — read-only. Used to seed the vault_authority signer and
    /// to validate position.market binding.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        constraint = matches!(market.lifecycle, MarketLifecycle::Open)
            @ SoothMarketError::MarketNotOpen,
    )]
    pub market: Box<Account<'info, Market>>,

    /// Vault authority signer-only PDA owned by `sooth_market`. We sign with
    /// it here on behalf of the AMM. CHECK: derived via seeds.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Market USDC vault — debited.
    #[account(
        mut,
        address = market.vault @ SoothMarketError::VaultAuthorityMismatch,
        constraint = vault.mint == crate::USDC_MINT_DEVNET
            @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// AMM lock-on-sell escrow vault — credited.
    #[account(
        mut,
        address = market.lock_vault @ SoothMarketError::VaultAuthorityMismatch,
        constraint = lock_vault.mint == crate::USDC_MINT_DEVNET
            @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub lock_vault: Box<Account<'info, TokenAccount>>,

    /// Per-(user, market) Position from `sooth_amm`. We can't type this as
    /// `Account<'info, sooth_amm::Position>` without a circular path-dep
    /// (sooth_amm already depends on sooth_market via the `cpi` feature).
    /// The handler verifies owner + parses `user`/`market` from raw bytes.
    /// CHECK: hand-validated in handler.
    pub position: UncheckedAccount<'info>,

    /// USDC mint reference. Pinned to canonical USDC.
    #[account(address = crate::USDC_MINT_DEVNET)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// User signature is the auth gate (the outer `sell_positions` ix
    /// requires a user signature; that flows down through the CPI).
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,

    /// Instructions sysvar — read by the parent-ix introspection check
    /// (see module docstring §"Auth model" and
    /// `instruction_introspection::require_parent_ix`). Pinned to the
    /// canonical sysvar pubkey via the `address` constraint so a malicious
    /// caller cannot substitute a forged sysvar account with a fabricated
    /// instruction list. CHECK: address-pinned.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<TransferToLock>, amount: u64) -> Result<()> {
    // ── 0. Parent-ix introspection ───────────────────────────────────────
    //
    // The auth-gap closer: refuse any call whose top-level ix list does not
    // include a sooth_amm `sell_positions` dispatch. Runs before the zero-
    // amount short-circuit so even a no-op direct call is rejected (the
    // introspection gate is the invariant; the zero-amount fast path is
    // an unrelated tolerance for LMSR rounding edges).
    require_parent_ix(
        &ctx.accounts.instruction_sysvar,
        &SELL_POSITIONS_DISCRIMINATOR,
    )?;

    if amount == 0 {
        // No-op for zero — keeps the CPI surface tolerant of LMSR rounding
        // edges where `proceeds_usdc == 0`. Mirrors the `if proceeds_usdc > 0`
        // guard the original sell_positions handler kept around the transfer.
        return Ok(());
    }

    // ── 1. Position validation: owner + user + market ────────────────────
    let position_ai = ctx.accounts.position.to_account_info();
    require_keys_eq!(
        *position_ai.owner,
        SOOTH_AMM_PROGRAM_ID,
        SoothMarketError::VaultAuthorityMismatch
    );
    let data = position_ai.try_borrow_data()?;
    require!(
        data.len() >= POSITION_MIN_LEN,
        SoothMarketError::VaultAuthorityMismatch
    );
    let pos_user = Pubkey::new_from_array(
        data[POSITION_USER_OFFSET..POSITION_USER_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(SoothMarketError::VaultAuthorityMismatch))?,
    );
    let pos_market = Pubkey::new_from_array(
        data[POSITION_MARKET_OFFSET..POSITION_MARKET_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(SoothMarketError::VaultAuthorityMismatch))?,
    );
    drop(data);
    require_keys_eq!(
        pos_user,
        ctx.accounts.user.key(),
        SoothMarketError::VaultAuthorityMismatch
    );
    require_keys_eq!(
        pos_market,
        ctx.accounts.market.key(),
        SoothMarketError::VaultAuthorityMismatch
    );

    // ── 2. PDA-signed CPI: vault → lock_vault ────────────────────────────
    let market_id = ctx.accounts.market.market_id;
    let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.lock_vault.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    Ok(())
}
