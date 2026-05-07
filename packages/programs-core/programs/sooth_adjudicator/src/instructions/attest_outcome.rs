//! `attest_outcome` — Manual variant. The per-market authority signs a
//! `winning_outcome`, which mutates Adjudicator state and CPIs into
//! `sooth_market::settle` to drive the market `Locked` → `Settled`.
//!
//! Architecture §4.4. EVM analogue: `TruthMarket.attest` + `TruthMarket.settle`
//! collapsed (`TruthMarket.sol:112-131`), with the authority check sourced
//! from the per-adjudicator implementation (e.g. `ManualAdjudicator`'s
//! `onlyOwner` modifier).
//!
//! ## Auth
//!
//! Two layers, defense-in-depth:
//!
//!   1. `adjudicator.authority` signs this ix. v1 Manual variant only —
//!      `ZkTLS` and `Other` variants are rejected with `UnsupportedKind`
//!      until a verifier program lands (architecture §7).
//!
//!   2. The CPI into `sooth_market::settle` is gated on `sooth_market`'s
//!      parent-ix introspection (`sooth_market::instruction_introspection`).
//!      That layer ensures *only* `sooth_adjudicator::attest_outcome`
//!      (matched by program-id + Anchor discriminator) can land the
//!      `Locked → Settled` mutation. The `AdjudicatorAllowlist` mitigation
//!      (commit abfcf15) remains in place as a third layer that constrains
//!      which pubkeys can ever be named `Market.adjudicator` at create-time.
//!
//! ## Idempotency
//!
//! `attest_outcome` is single-shot per market. If `adjudicator.attested_outcome`
//! is already `Some`, the ix rejects with `AlreadyAttested`. Re-attesting
//! would be a soundness break — the market would have already settled at
//! the first attestation's CPI, so a second attestation must not be
//! possible regardless of upstream state.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use sooth_market::cpi::accounts::Settle;
use sooth_market::program::SoothMarket;
use sooth_market::state::Market;

use crate::error::SoothAdjudicatorError;
use crate::events::OutcomeAttested;
use crate::state::{Adjudicator, AdjudicatorKind, ADJUDICATOR_SEED};

/// Protocol-wide OUTCOME encoding. Mirrors `glossary.md` and the constants
/// in `sooth_market::state::market` / `sooth_amm`.
const OUTCOME_NO: u8 = 0;
const OUTCOME_YES: u8 = 1;
const OUTCOME_INVALID: u8 = 2;

#[derive(Accounts)]
pub struct AttestOutcome<'info> {
    /// Per-market `Adjudicator` PDA. Mutated to record the attested outcome
    /// + timestamp.
    #[account(
        mut,
        seeds = [ADJUDICATOR_SEED, market.key().as_ref()],
        bump = adjudicator.bump,
        constraint = adjudicator.market == market.key()
            @ SoothAdjudicatorError::MarketMismatch,
    )]
    pub adjudicator: Account<'info, Adjudicator>,

    /// `sooth_market::Market` PDA — mutated by the CPI into `settle`.
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Account<'info, Market>,

    /// Authority signer. v1 Manual variant: `adjudicator.authority`.
    pub authority: Signer<'info>,

    /// `sooth_market` program — CPI'd into for the actual settle.
    pub sooth_market_program: Program<'info, SoothMarket>,

    /// Instructions sysvar — forwarded to `sooth_market::settle` where the
    /// parent-ix introspection pins the caller to this program. Pinned to
    /// the canonical sysvar pubkey. CHECK: address-pinned.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<AttestOutcome>, winning_outcome: u8) -> Result<()> {
    // ── 1. Outcome shape ─────────────────────────────────────────────────
    require!(
        winning_outcome == OUTCOME_NO
            || winning_outcome == OUTCOME_YES
            || winning_outcome == OUTCOME_INVALID,
        SoothAdjudicatorError::InvalidOutcome
    );

    // ── 2. Variant gating — v1 Manual only ───────────────────────────────
    //
    // ZkTLS / Other variants reach here only if a future register call set
    // an unsupported kind. The kind is committed at register time so this
    // also catches mis-registered records.
    require!(
        matches!(ctx.accounts.adjudicator.kind, AdjudicatorKind::Manual),
        SoothAdjudicatorError::UnsupportedKind
    );

    // ── 3. Authority signature ───────────────────────────────────────────
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.adjudicator.authority,
        SoothAdjudicatorError::NotAuthority
    );

    // ── 4. Idempotency guard ─────────────────────────────────────────────
    require!(
        !ctx.accounts.adjudicator.is_attested(),
        SoothAdjudicatorError::AlreadyAttested
    );

    // ── 5. Mutate Adjudicator state ──────────────────────────────────────
    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let adjudicator_key = ctx.accounts.adjudicator.key();
    {
        let adj = &mut ctx.accounts.adjudicator;
        adj.attested_outcome = Some(winning_outcome);
        adj.attested_at = Some(now);
    }

    // ── 6. CPI into sooth_market::settle ─────────────────────────────────
    //
    // The destination ix re-validates `winning_outcome`, gates on its own
    // parent-ix introspection (program-id == sooth_adjudicator::ID + the
    // `attest_outcome` discriminator), and drives Locked → Settled.
    let cpi_accounts = Settle {
        market: ctx.accounts.market.to_account_info(),
        adjudicator_pda: ctx.accounts.adjudicator.to_account_info(),
        instruction_sysvar: ctx.accounts.instruction_sysvar.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(
        ctx.accounts.sooth_market_program.to_account_info(),
        cpi_accounts,
    );
    sooth_market::cpi::settle(cpi_ctx, winning_outcome)?;

    // ── 7. Emit ──────────────────────────────────────────────────────────
    emit!(OutcomeAttested {
        market: market_key,
        adjudicator: adjudicator_key,
        winning_outcome,
        ts: now,
    });

    Ok(())
}
