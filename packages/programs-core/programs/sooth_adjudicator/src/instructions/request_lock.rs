//! `request_lock` — adjudicator-side entry point that transitions a market
//! from `Open` → `Locked` via CPI into `sooth_market::lock_for_resolution`.
//!
//! Architecture §4.4. EVM analogue: `TruthMarket.resolve` invocation gated
//! on `msg.sender == adjudicator()`. The Solana equivalent is this ix, which
//! holds the per-market authority gate, then CPIs into the corresponding
//! `sooth_market` ix. `sooth_market::lock_for_resolution` itself uses
//! parent-instruction introspection (the same Wave A pattern as
//! `transfer_to_lock`) to verify the caller is `sooth_adjudicator`.
//!
//! ## Why a separate ix (vs. baking lock into attest_outcome)
//!
//! Architecture §4.4 sketches a multi-phase flow `resolve → attest → settle`
//! with a veto branch on dispute. Even though v1 collapses RESOLVING +
//! ATTESTED into `Locked` on the market state, the *trigger* for the lock
//! and the trigger for settle remain conceptually distinct — markets are
//! locked when the adjudicator commits to producing an outcome (potentially
//! with a delay before attestation), and settled when the outcome is final.
//! Splitting `request_lock` from `attest_outcome` keeps the IDL surface
//! ready for the dispute path without re-adding an ix later.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use sooth_market::cpi::accounts::LockForResolution;
use sooth_market::program::SoothMarket;
use sooth_market::state::Market;

use crate::error::SoothAdjudicatorError;
use crate::state::{Adjudicator, ADJUDICATOR_SEED};

#[derive(Accounts)]
pub struct RequestLock<'info> {
    /// Per-market `Adjudicator` PDA. Bound to `market` via the seed; the
    /// handler also re-checks `adjudicator.market == market.key()` for
    /// belt-and-braces parity with the seed constraint.
    #[account(
        seeds = [ADJUDICATOR_SEED, market.key().as_ref()],
        bump = adjudicator.bump,
        constraint = adjudicator.market == market.key()
            @ SoothAdjudicatorError::MarketMismatch,
    )]
    pub adjudicator: Account<'info, Adjudicator>,

    /// `sooth_market::Market` PDA — mutated by the CPI into
    /// `lock_for_resolution`. Marked `mut` to flow the writability through.
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Account<'info, Market>,

    /// Authority signer. v1 Manual variant: `adjudicator.authority` signs
    /// to request a lock. Future variants (ZkTLS, dispute-replays) may
    /// derive this from a verifier program instead.
    pub authority: Signer<'info>,

    /// `sooth_market` program — CPI'd into for the actual state mutation.
    pub sooth_market_program: Program<'info, SoothMarket>,

    /// Instructions sysvar — forwarded to `sooth_market::lock_for_resolution`
    /// where parent-ix introspection confirms the caller is this program.
    /// Pinned to the canonical sysvar pubkey via the `address` constraint
    /// so a malicious caller cannot substitute a forged sysvar account.
    /// CHECK: address-pinned downstream and here.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<RequestLock>) -> Result<()> {
    // ── Auth — Manual variant ─────────────────────────────────────────────
    //
    // The authority gate is identical for `request_lock` and `attest_outcome`
    // — both require `adjudicator.authority`'s signature for the `Manual`
    // variant. Future variants (ZkTLS) would replace this with a verifier-
    // program check.
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.adjudicator.authority,
        SoothAdjudicatorError::NotAuthority
    );

    // ── CPI: sooth_market::lock_for_resolution ────────────────────────────
    //
    // `sooth_market::lock_for_resolution` uses parent-ix introspection to
    // verify the top-level caller is this program with the matching
    // discriminator. The user-facing security invariant: only this ix can
    // drive a market into `Locked` after the introspection patch lands.
    let cpi_accounts = LockForResolution {
        market: ctx.accounts.market.to_account_info(),
        adjudicator_pda: ctx.accounts.adjudicator.to_account_info(),
        instruction_sysvar: ctx.accounts.instruction_sysvar.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(
        ctx.accounts.sooth_market_program.to_account_info(),
        cpi_accounts,
    );
    sooth_market::cpi::lock_for_resolution(cpi_ctx)?;

    Ok(())
}
