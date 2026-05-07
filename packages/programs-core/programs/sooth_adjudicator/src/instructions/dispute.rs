//! `dispute` — veto branch on an attested outcome (architecture §4.4).
//!
//! ## Flow
//!
//! Once `attest_outcome` has populated `Adjudicator.attested_outcome`, the
//! `dispute_authority` can override the outcome by submitting `dispute(
//! new_outcome)`. The new outcome may be `INVALID` (the EVM-style "force
//! invalidation") or any other valid value (`NO` / `YES`). The handler:
//!
//!   1. asserts the market is not yet `Settled` (post-settle the outcome is
//!      terminal — a late dispute would be a soundness break).
//!   2. asserts the original attestation has happened (else there is nothing
//!      to dispute — the resolve/attest path is the canonical first leg).
//!   3. asserts `!disputed` (one-shot per market — preserves the EVM
//!      semantics where `dispute` returns the market to ACTIVE for re-resolve;
//!      v1 collapses that to "the dispute *is* the new attestation").
//!   4. requires `dispute_authority`'s signature.
//!   5. mutates `attested_outcome = Some(new_outcome)` + `disputed = true` +
//!      `disputed_at = Some(now)` (note: `attested_at` is preserved so
//!      indexers can reconstruct the timeline).
//!   6. CPIs into `sooth_market::settle` with the new outcome. The settle
//!      handler's parent-ix introspection accepts either ATTEST_OUTCOME or
//!      DISPUTE as the legitimate parent (see
//!      `sooth_market::instructions::settle`).
//!   7. emits `DisputeRaised`.
//!
//! ## Q1 — auth model (decision recorded for the design log)
//!
//! EVM `AdjudicatorBase.dispute()` is gated on a per-adjudicator guardian
//! whitelist (`_guardians[msg.sender]`). For v1 Solana we collapse the
//! whitelist to a single `dispute_authority` Pubkey on the `Adjudicator`
//! PDA, defaulted at register-time to the same key as the attestation
//! authority. Rationale:
//!
//!   - Preserves the EVM split (separate dispute role) at the storage
//!     level, so production rotation (e.g. founder-multisig as
//!     `dispute_authority`) is a single field write rather than an account
//!     migration.
//!   - Avoids the cost + state surface of a multi-pubkey whitelist for v1
//!     where the protocol only ships a single guardian role anyway.
//!
//! ## Q2 — window vs. unbounded
//!
//! EVM uses a `vetoPeriod` window between `attest()` and `settle()`. For v1
//! Solana we make `dispute` permissionless-in-time-but-authority-gated:
//! callable any time *before* `settle` runs, no window enforced. Rationale:
//!
//!   - `attest_outcome` already CPIs straight into `settle` in v1 (the
//!     adjudicator state machine collapses ATTESTED + SETTLED for the
//!     happy path), so a window of "between attest and settle" doesn't
//!     exist in v1's calling pattern.
//!   - The `disputed_at` timestamp is recorded so a future veto-window
//!     upgrade can land as a single handler edit rather than an account
//!     migration.
//!
//! See module docstring on `state/adjudicator.rs` for the field shape.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use sooth_market::cpi::accounts::Settle;
use sooth_market::program::SoothMarket;
use sooth_market::state::{Market, MarketLifecycle};

use crate::error::SoothAdjudicatorError;
use crate::events::DisputeRaised;
use crate::state::{Adjudicator, ADJUDICATOR_SEED};

/// Protocol-wide OUTCOME encoding. Mirrors `attest_outcome.rs` and the
/// constants in `sooth_market::state::market` / `sooth_amm`.
const OUTCOME_NO: u8 = 0;
const OUTCOME_YES: u8 = 1;
const OUTCOME_INVALID: u8 = 2;

#[derive(Accounts)]
pub struct Dispute<'info> {
    /// Per-market `Adjudicator` PDA — mutated to record the new outcome and
    /// set the `disputed` flag.
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

    /// Disputer signer. v1 collapses the EVM guardian whitelist into a
    /// single `dispute_authority` Pubkey on the `Adjudicator` PDA. See
    /// module docstring for the rationale.
    pub disputer: Signer<'info>,

    /// `sooth_market` program — CPI'd into for the actual settle.
    pub sooth_market_program: Program<'info, SoothMarket>,

    /// Instructions sysvar — forwarded to `sooth_market::settle` where the
    /// parent-ix introspection accepts either `attest_outcome` OR `dispute`
    /// as the legitimate parent. Pinned to the canonical sysvar pubkey.
    /// CHECK: address-pinned.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<Dispute>, new_outcome: u8) -> Result<()> {
    // ── 1. Outcome shape ─────────────────────────────────────────────────
    require!(
        new_outcome == OUTCOME_NO
            || new_outcome == OUTCOME_YES
            || new_outcome == OUTCOME_INVALID,
        SoothAdjudicatorError::InvalidOutcome
    );

    // ── 2. Market not already settled ────────────────────────────────────
    //
    // Once `settle` has run the outcome is terminal — a late dispute would
    // be a soundness break (redemptions may already be in flight against
    // the now-final outcome). The lifecycle gate on `sooth_market::settle`
    // already prevents `Settled → Settled`, but rejecting here surfaces a
    // dedicated error code rather than a generic lifecycle one.
    require!(
        !matches!(ctx.accounts.market.lifecycle, MarketLifecycle::Settled),
        SoothAdjudicatorError::MarketAlreadySettled
    );

    // ── 3. Original attestation must have happened ───────────────────────
    require!(
        ctx.accounts.adjudicator.is_attested(),
        SoothAdjudicatorError::NotAttested
    );

    // ── 4. One-shot guard ────────────────────────────────────────────────
    require!(
        !ctx.accounts.adjudicator.is_disputed(),
        SoothAdjudicatorError::AlreadyDisputed
    );

    // ── 5. Auth: dispute_authority signs ─────────────────────────────────
    require_keys_eq!(
        ctx.accounts.disputer.key(),
        ctx.accounts.adjudicator.dispute_authority,
        SoothAdjudicatorError::NotDisputeAuthority
    );

    // ── 6. Mutate Adjudicator state ──────────────────────────────────────
    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let adjudicator_key = ctx.accounts.adjudicator.key();
    let disputer_key = ctx.accounts.disputer.key();
    // Capture the previous outcome for the event audit trail before the
    // override. `is_attested` was asserted in step 3 so unwrap is safe.
    let previous_outcome = ctx
        .accounts
        .adjudicator
        .attested_outcome
        .expect("attested_outcome verified in is_attested check above");
    {
        let adj = &mut ctx.accounts.adjudicator;
        // Override the outcome — note that `attested_at` is intentionally
        // preserved as the timestamp of the original attestation; the new
        // dispute timestamp lives on `disputed_at`.
        adj.attested_outcome = Some(new_outcome);
        adj.disputed = true;
        adj.disputed_at = Some(now);
    }

    // ── 7. CPI into sooth_market::settle with the (possibly-overridden)
    //       outcome. Settle's parent-ix introspection accepts this ix's
    //       discriminator as a legitimate parent (see
    //       `sooth_market::instructions::settle`).
    let cpi_accounts = Settle {
        market: ctx.accounts.market.to_account_info(),
        adjudicator_pda: ctx.accounts.adjudicator.to_account_info(),
        instruction_sysvar: ctx.accounts.instruction_sysvar.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(
        ctx.accounts.sooth_market_program.to_account_info(),
        cpi_accounts,
    );
    sooth_market::cpi::settle(cpi_ctx, new_outcome)?;

    // ── 8. Emit ──────────────────────────────────────────────────────────
    emit!(DisputeRaised {
        market: market_key,
        adjudicator: adjudicator_key,
        disputer: disputer_key,
        previous_outcome,
        new_outcome,
        ts: now,
    });

    Ok(())
}
