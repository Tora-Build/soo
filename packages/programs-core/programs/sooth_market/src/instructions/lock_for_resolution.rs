//! `lock_for_resolution` — halt trading; market enters Locked state pending
//! adjudicator outcome.
//!
//! EVM analogue: `TruthMarket.resolve` (`TruthMarket.sol:90-106`) which
//! transitions LIVE → RESOLVING. On Solana we collapse RESOLVING + ATTESTED
//! into `Locked` (see `state/lifecycle.rs`).
//!
//! ## Authority gating
//!
//! EVM: `require(msg.sender == adjudicator())`. Solana equivalent — now
//! wired — is parent-ix introspection: the calling top-level ix must be
//! `sooth_adjudicator::request_lock` (matched by program-id + Anchor
//! discriminator). This replaces the prior loose signer-key check that
//! accepted any signer whose pubkey equaled `market.adjudicator`. The Wave
//! A pattern (`instruction_introspection.rs`) is reused.
//!
//! ## Defense-in-depth (per architecture §4.4)
//!
//!   1. `sooth_market::AdjudicatorAllowlist` (commit abfcf15) constrains the
//!      *set* of pubkeys ever named as `Market.adjudicator`.
//!   2. `sooth_adjudicator::Adjudicator` PDA records the per-market authority
//!      (post-create registration).
//!   3. THIS gate — parent-ix introspection — pins the actual call to the
//!      adjudicator program, closing the deferred half of Codex's C2.
//!
//! All three layers stay in place. Removing any one widens the attack
//! surface in a documented, traceable way.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::error::SoothMarketError;
use crate::events::MarketLocked;
use crate::instruction_introspection::{require_adjudicator_parent_ix, REQUEST_LOCK_DISCRIMINATOR};
use crate::state::{Market, MarketLifecycle};

#[derive(Accounts)]
pub struct LockForResolution<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// `sooth_adjudicator::Adjudicator` PDA — read-only here. Forwarded by
    /// the CPI from `sooth_adjudicator::request_lock`. Pinned to the
    /// matching adjudicator-program seed via the `owner` constraint so a
    /// caller cannot substitute a forged Adjudicator account from another
    /// program. CHECK: ownership-pinned; the contents are not parsed here
    /// (the introspection check is the load-bearing auth gate; this account
    /// is along for the ride to keep the CPI account-list shape parallel
    /// to `settle` and to give indexers a stable reference).
    #[account(
        owner = crate::SOOTH_ADJUDICATOR_PROGRAM_ID @ SoothMarketError::NotAdjudicator,
    )]
    pub adjudicator_pda: UncheckedAccount<'info>,

    /// Instructions sysvar — read by the parent-ix introspection check.
    /// Pinned to the canonical sysvar pubkey via the `address` constraint
    /// so a malicious caller cannot substitute a forged sysvar account.
    /// CHECK: address-pinned.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<LockForResolution>) -> Result<()> {
    // ── Auth — parent-ix introspection ───────────────────────────────────
    //
    // The calling top-level ix MUST be `sooth_adjudicator::request_lock`.
    // The introspection scans the tx's ix list and matches program-id +
    // Anchor discriminator. See `instruction_introspection.rs` for the
    // mechanism. This closes the deferred half of Codex's C2 finding.
    require_adjudicator_parent_ix(
        &ctx.accounts.instruction_sysvar,
        &REQUEST_LOCK_DISCRIMINATOR,
    )?;

    let market = &mut ctx.accounts.market;
    require!(
        market.lifecycle.can_transition_to(MarketLifecycle::Locked),
        SoothMarketError::InvalidLifecycleTransition
    );
    market.lifecycle = MarketLifecycle::Locked;

    let now = Clock::get()?.unix_timestamp;
    emit!(MarketLocked {
        market: market.key(),
        ts: now,
    });

    Ok(())
}
