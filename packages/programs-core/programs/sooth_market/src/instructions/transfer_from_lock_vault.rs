//! `transfer_from_lock_vault` — PDA-signed USDC transfer
//! `lock_vault → recipient`.
//!
//! Wave 1B helper for `sooth_amm::claim_unlocked`. Companion to
//! `transfer_to_lock`; same PDA-ownership rationale (the `lock_authority`
//! PDA is owned by `sooth_market`, so only this program can sign with it).
//!
//! ## Auth model (this commit only — see TODO in `transfer_to_lock.rs`)
//!
//! User signature gates the transfer. We additionally validate:
//!
//!   1. `lock_entry.owner == sooth_amm::ID`
//!   2. `lock_entry.user == user.key()`
//!   3. `lock_entry.market == market.key()`
//!
//! Maturity (`now >= lock_entry.unlock_at`) and account closure
//! (`close = user`) stay on the `sooth_amm::claim_unlocked` side — this
//! helper only does the PDA-signed transfer.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothMarketError;
use crate::state::Market;
use crate::SOOTH_AMM_PROGRAM_ID;

/// LockEntry account layout (mirrored from `sooth_amm::state::LockEntry`):
///   8 disc + 32 user + 32 market + 8 amount_usdc + 8 unlock_at + 8 nonce + 1 bump
const LOCK_ENTRY_USER_OFFSET: usize = 8;
const LOCK_ENTRY_MARKET_OFFSET: usize = 8 + 32;
const LOCK_ENTRY_MIN_LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1;

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
}

pub fn handler(ctx: Context<TransferFromLockVault>, amount: u64) -> Result<()> {
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
