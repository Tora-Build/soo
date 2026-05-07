//! `settle` — finalize a Locked market with the adjudicator's winning outcome.
//!
//! EVM analogue: `TruthMarket.attest` + `TruthMarket.settle` collapsed
//! (`TruthMarket.sol:112-131`). On Solana we don't run an
//! ATTESTED-with-veto-window phase in v1 — the adjudicator program is
//! responsible for any dispute logic before calling `settle`, and the on-
//! market state goes Locked → Settled in a single ix.
//!
//! ## Authority gating
//!
//! Parent-ix introspection — same shape as `lock_for_resolution`. The
//! calling top-level ix MUST be `sooth_adjudicator::attest_outcome` (matched
//! by program-id + Anchor discriminator). This is the call-time auth gate
//! that closes the deferred half of Codex's C2 finding; the abfcf15
//! `AdjudicatorAllowlist` mitigation remains in place as create-time
//! defense-in-depth.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::error::SoothMarketError;
use crate::events::MarketSettled;
use crate::instruction_introspection::{
    require_adjudicator_parent_ix, ATTEST_OUTCOME_DISCRIMINATOR,
};
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::{Market, MarketLifecycle};

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// `sooth_adjudicator::Adjudicator` PDA — read-only here. Forwarded by
    /// the CPI from `sooth_adjudicator::attest_outcome`. Pinned via owner
    /// constraint (same rationale as `lock_for_resolution`). CHECK:
    /// ownership-pinned; introspection is the load-bearing auth gate.
    #[account(
        owner = crate::SOOTH_ADJUDICATOR_PROGRAM_ID @ SoothMarketError::NotAdjudicator,
    )]
    pub adjudicator_pda: UncheckedAccount<'info>,

    /// Instructions sysvar for parent-ix introspection. Address-pinned.
    /// CHECK: address-pinned.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<Settle>, winning_outcome: u8) -> Result<()> {
    require!(
        winning_outcome == OUTCOME_NO
            || winning_outcome == OUTCOME_YES
            || winning_outcome == OUTCOME_INVALID,
        SoothMarketError::InvalidOutcome
    );

    // ── Auth — parent-ix introspection ───────────────────────────────────
    //
    // Caller MUST be `sooth_adjudicator::attest_outcome`. See
    // `instruction_introspection.rs` for the mechanism and
    // `lock_for_resolution.rs` for the layered-defense rationale.
    require_adjudicator_parent_ix(
        &ctx.accounts.instruction_sysvar,
        &ATTEST_OUTCOME_DISCRIMINATOR,
    )?;

    let market = &mut ctx.accounts.market;
    require!(
        market.lifecycle.can_transition_to(MarketLifecycle::Settled),
        SoothMarketError::InvalidLifecycleTransition
    );
    market.lifecycle = MarketLifecycle::Settled;
    market.winning_outcome = winning_outcome;

    let now = Clock::get()?.unix_timestamp;
    emit!(MarketSettled {
        market: market.key(),
        winning_outcome,
        ts: now,
    });

    Ok(())
}
