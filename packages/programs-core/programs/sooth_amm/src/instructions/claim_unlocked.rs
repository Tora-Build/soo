//! `claim_unlocked` — drain a single `LockEntry` after its 24h lock elapses.
//!
//! Architecture §4.3 — companion to the sell branch of `trade_positions`.
//! EVM analogue: `AMMEngine.claimUnlocked` (`AMMEngine.sol:351-408`); the
//! Solana port handles one `LockEntry` per call rather than batching the
//! whole queue, because Solana account loading is per-account explicit
//! (there's no Solidity-style storage iteration). Front-ends fan out one
//! `claim_unlocked` ix per matured lock.
//!
//! ## Flow
//!
//! 1. Resolve `LockEntry` PDA — already cross-checked against `position`
//!    via the seed derivation `[b"lock_entry", position.key(), nonce]`.
//! 2. Require `Clock::unix_timestamp >= lock_entry.unlock_at`.
//! 3. PDA-signed `spl-token::transfer lock_vault → user_usdc_ata` for
//!    `lock_entry.amount_usdc`, signed by `lock_authority` (seeds
//!    `[b"lock", market_id]`, owner = `sooth_market`).
//! 4. Emit `LockClaimed`.
//! 5. Anchor closes `lock_entry` (rent → `user`) via the `close = user`
//!    constraint.
//!
//! ## Why one-lock-per-call
//!
//! EVM's `claimUnlocked` walks `_lockQueue[msg.sender]` in storage and
//! amortises gas across multiple matured locks. On Solana the LockEntries
//! aren't a list — each is a separate account, and Anchor needs every
//! account in `Accounts<'info>` declared statically. A batched variant
//! would either hard-cap the batch size or use `remaining_accounts`
//! (which loses Anchor's type-safety for each lock). One-per-call is
//! simpler; the SDK can submit a versioned tx with up to ~64 of these in
//! a single landed transaction.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothAmmError;
use crate::events::LockClaimed;
use crate::state::{LockEntry, Market, Position};

#[derive(Accounts)]
pub struct ClaimUnlocked<'info> {
    /// Market PDA — owned by `sooth_market`. Read only; we need it to
    /// derive `lock_authority` seeds and to cross-check `lock_vault`.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Box<Account<'info, Market>>,

    /// Per-(user, market) Position. Used purely to validate the
    /// `lock_entry` seed derivation; not mutated here.
    #[account(
        seeds = [b"pos", market.market_id.as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = user @ SoothAmmError::Unauthorized,
        has_one = market @ SoothAmmError::Unauthorized,
    )]
    pub position: Box<Account<'info, Position>>,

    /// Lock entry to drain + close. Anchor's `close = user` refunds the
    /// rent lamports to `user` and zeroes the discriminator on success.
    ///
    /// Seed derivation `[b"lock_entry", position.key(), nonce]` is the
    /// only authority check we need: only the user (signer) for the
    /// `Position` PDA derivation can have produced this account in the
    /// first place. The `has_one = user / market` checks below are belt-
    /// and-braces against a future change to seed structure.
    #[account(
        mut,
        close = user,
        seeds = [
            b"lock_entry",
            position.key().as_ref(),
            lock_entry.nonce.to_le_bytes().as_ref(),
        ],
        bump = lock_entry.bump,
        has_one = user @ SoothAmmError::Unauthorized,
        has_one = market @ SoothAmmError::Unauthorized,
    )]
    pub lock_entry: Box<Account<'info, LockEntry>>,

    /// Lock-authority signer-only PDA owned by `sooth_market`. Seeds
    /// `[b"lock", market_id]` match `initialize_market_vaults`.
    /// CHECK: derived via seeds; no data.
    #[account(
        seeds = [b"lock", market.market_id.as_ref()],
        bump = market.lock_authority_bump,
        seeds::program = sooth_market::ID,
    )]
    pub lock_authority: UncheckedAccount<'info>,

    /// Market lock vault — the ATA owned by `lock_authority` from which
    /// we move USDC out. Pinned to the canonical USDC mint via the
    /// `usdc_mint` reference, and cross-checked against `market.lock_vault`
    /// so a forged ATA can't be substituted.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = lock_authority,
        constraint = lock_vault.key() == market.lock_vault @ SoothAmmError::LockVaultMismatch,
    )]
    pub lock_vault: Box<Account<'info, TokenAccount>>,

    /// User's USDC ATA — credited.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = user,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// USDC mint reference. Pinned to the canonical cluster USDC.
    #[account(address = crate::USDC_MINT_DEVNET)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// Lock owner — receives the USDC + the rent refund from closing
    /// `lock_entry`.
    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimUnlocked>) -> Result<()> {
    // ── 1. Maturity gate ─────────────────────────────────────────────────
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.lock_entry.unlock_at,
        SoothAmmError::LockNotElapsed
    );

    let amount = ctx.accounts.lock_entry.amount_usdc;
    let market_pubkey = ctx.accounts.market.key();
    let lock_entry_pubkey = ctx.accounts.lock_entry.key();
    let user_pubkey = ctx.accounts.user.key();

    // ── 2. PDA-signed CPI: lock_vault → user_usdc_ata ────────────────────
    let market_id = ctx.accounts.market.market_id;
    let lock_authority_bump = ctx.accounts.market.lock_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"lock",
        market_id.as_ref(),
        &[lock_authority_bump],
    ]];

    if amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.lock_vault.to_account_info(),
                    to: ctx.accounts.user_usdc_ata.to_account_info(),
                    authority: ctx.accounts.lock_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    }

    // ── 3. Emit ──────────────────────────────────────────────────────────
    emit!(LockClaimed {
        market: market_pubkey,
        user: user_pubkey,
        lock_entry: lock_entry_pubkey,
        amount_usdc: amount,
        ts: now,
    });

    // ── 4. Close happens automatically via `close = user` constraint ─────
    Ok(())
}
