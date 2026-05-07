//! `transfer_from_lock_vault` — PDA-signed USDC transfer
//! `lock_vault → recipient`.
//!
//! Wave 1B helper for `sooth_amm::claim_unlocked`. Companion to
//! `transfer_to_lock`; same PDA-ownership rationale (the `lock_authority`
//! PDA is owned by `sooth_market`, so only this program can sign with it).
//!
//! ## Auth model
//!
//! Two layered gates:
//!
//!   1. **User signature** — flowed down from `claim_unlocked` via CPI.
//!   2. **Parent-ix introspection** — the runtime's `Instructions` sysvar is
//!      walked to confirm one of the preceding top-level ixs is from
//!      `sooth_amm` with the `claim_unlocked` discriminator. Closes the
//!      same solvency hole as `transfer_to_lock.rs` (a direct call could
//!      drain `lock_vault` without closing a `LockEntry`, so the per-sell
//!      escrow accounting drifts from on-chain state). See
//!      `instruction_introspection.rs` for the mechanism.
//!
//! LockEntry-shape checks remain belt-and-braces:
//!
//!   1. `lock_entry.owner == sooth_amm::ID`
//!   2. `lock_entry.user == user.key()`
//!   3. `lock_entry.market == market.key()`
//!
//! Maturity (`now >= lock_entry.unlock_at`) and account closure
//! (`close = user`) stay on the `sooth_amm::claim_unlocked` side — this
//! helper only does the PDA-signed transfer.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothMarketError;
use crate::instruction_introspection::{require_parent_ix, CLAIM_UNLOCKED_DISCRIMINATOR};
use crate::state::Market;
use crate::SOOTH_AMM_PROGRAM_ID;

// LockEntry account layout — sourced from `sooth-account-offsets` (see
// crate-level docstring). The compile-time assertion in
// `sooth_amm::state::lock_entry` ties `LOCK_ENTRY_TOTAL_LEN` to the live
// `LockEntry::SPACE`, so any drift here trips the build of `sooth_amm`.
use sooth_account_offsets::{
    LOCK_ENTRY_MARKET_OFFSET, LOCK_ENTRY_TOTAL_LEN as LOCK_ENTRY_MIN_LEN,
    LOCK_ENTRY_USER_OFFSET,
};

#[derive(Accounts)]
pub struct TransferFromLockVault<'info> {
    /// Market PDA — read-only. Used to seed the lock_authority signer.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// Lock-authority signer-only PDA owned by `sooth_market`. CHECK: derived.
    #[account(
        seeds = [b"lock", market.market_id.as_ref()],
        bump = market.lock_authority_bump,
    )]
    pub lock_authority: UncheckedAccount<'info>,

    /// AMM lock-on-sell escrow vault — debited.
    #[account(
        mut,
        address = market.lock_vault @ SoothMarketError::VaultAuthorityMismatch,
        constraint = lock_vault.mint == crate::USDC_MINT_DEVNET
            @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub lock_vault: Box<Account<'info, TokenAccount>>,

    /// Recipient USDC ATA (the user's token account).
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = user,
    )]
    pub recipient: Box<Account<'info, TokenAccount>>,

    /// LockEntry account from `sooth_amm`. Owner + field validation runs in
    /// the handler (see module docstring). CHECK: hand-validated.
    pub lock_entry: UncheckedAccount<'info>,

    /// USDC mint reference. Pinned to canonical USDC.
    #[account(address = crate::USDC_MINT_DEVNET)]
    pub usdc_mint: Box<Account<'info, Mint>>,

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

pub fn handler(ctx: Context<TransferFromLockVault>, amount: u64) -> Result<()> {
    // ── 0. Parent-ix introspection ───────────────────────────────────────
    //
    // Symmetric to `transfer_to_lock`: refuse any call whose top-level ix
    // list does not include a sooth_amm `claim_unlocked` dispatch. Runs
    // before the zero-amount short-circuit on the same rationale.
    require_parent_ix(
        &ctx.accounts.instruction_sysvar,
        &CLAIM_UNLOCKED_DISCRIMINATOR,
    )?;

    if amount == 0 {
        // No-op for zero — defensive parity with `transfer_to_lock`.
        return Ok(());
    }

    // ── 1. LockEntry validation: owner + user + market ───────────────────
    let lock_entry_ai = ctx.accounts.lock_entry.to_account_info();
    require_keys_eq!(
        *lock_entry_ai.owner,
        SOOTH_AMM_PROGRAM_ID,
        SoothMarketError::VaultAuthorityMismatch
    );
    let data = lock_entry_ai.try_borrow_data()?;
    require!(
        data.len() >= LOCK_ENTRY_MIN_LEN,
        SoothMarketError::VaultAuthorityMismatch
    );
    let entry_user = Pubkey::new_from_array(
        data[LOCK_ENTRY_USER_OFFSET..LOCK_ENTRY_USER_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(SoothMarketError::VaultAuthorityMismatch))?,
    );
    let entry_market = Pubkey::new_from_array(
        data[LOCK_ENTRY_MARKET_OFFSET..LOCK_ENTRY_MARKET_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(SoothMarketError::VaultAuthorityMismatch))?,
    );
    drop(data);
    require_keys_eq!(
        entry_user,
        ctx.accounts.user.key(),
        SoothMarketError::VaultAuthorityMismatch
    );
    require_keys_eq!(
        entry_market,
        ctx.accounts.market.key(),
        SoothMarketError::VaultAuthorityMismatch
    );

    // ── 2. PDA-signed CPI: lock_vault → recipient ────────────────────────
    let market_id = ctx.accounts.market.market_id;
    let lock_authority_bump = ctx.accounts.market.lock_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"lock", market_id.as_ref(), &[lock_authority_bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.lock_vault.to_account_info(),
                to: ctx.accounts.recipient.to_account_info(),
                authority: ctx.accounts.lock_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    Ok(())
}
