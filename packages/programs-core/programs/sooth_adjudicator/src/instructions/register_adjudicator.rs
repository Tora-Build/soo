//! `register_adjudicator` — create the per-market `Adjudicator` PDA.
//!
//! Architecture §4.4 + §7. EVM analogue: the implicit per-market record
//! created when `LaunchpadEngine.createMarket` calls
//! `IAdjudicator(adjudicator).configureMarket(market, config)` (e.g.
//! `AdjudicatorBase._onConfigure` for the Manual variant).
//!
//! ## Auth model
//!
//! `register_adjudicator` is permissioned to the protocol multisig: the same
//! key that controls `sooth_market::AdjudicatorAllowlist`'s authority. This
//! mirrors the layered design — the `AdjudicatorAllowlist` (Codex C2 abfcf15
//! mitigation) controls the *set* of valid adjudicator pubkeys; this ix
//! controls *which markets* a given adjudicator services. Both layers stay
//! in place: the allowlist remains as defense-in-depth even after the CPI
//! introspection check on `sooth_market::settle` is wired (this ix's effect).
//!
//! Tightened auth in v1: this ix accepts the market.creator as the registrar.
//! In production the registrar would be the protocol multisig managing the
//! allowlist; collapsing them is a deliberate v1 simplification mirroring
//! `seed-localnet.mjs`'s collapse of allowlist-authority and demo-adjudicator
//! roles. Flag in report.
//!
//! ## What this ix does NOT do
//!
//! - Mutate `sooth_market::Market` state — the existing market.adjudicator
//!   field is set at `initialize_market` time and remains the source of
//!   truth for the Manual variant's authority. This PDA carries the kind +
//!   attestation state (which the EVM keeps in implementation-specific
//!   storage on each adjudicator contract).

use anchor_lang::prelude::*;

use sooth_market::state::Market;

use crate::error::SoothAdjudicatorError;
use crate::events::AdjudicatorRegistered;
use crate::state::{Adjudicator, AdjudicatorKind, ADJUDICATOR_SEED};

#[derive(Accounts)]
pub struct RegisterAdjudicator<'info> {
    /// New per-market `Adjudicator` PDA. `init` (not `init_if_needed`) — re-
    /// init must be impossible; switching adjudicator type post-creation
    /// would break the lifecycle invariants on `sooth_market::Market`.
    #[account(
        init,
        payer = signer,
        space = Adjudicator::SPACE,
        seeds = [ADJUDICATOR_SEED, market.key().as_ref()],
        bump,
    )]
    pub adjudicator: Account<'info, Adjudicator>,

    /// `sooth_market::Market` PDA — read-only here. Used to bind the
    /// Adjudicator record to a specific market. The `seeds::program`
    /// constraint pins ownership: a forged Market account from a different
    /// program would fail account-resolution.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Account<'info, Market>,

    /// Pays rent + signs as the registrar. v1 accepts `market.creator`
    /// (collapsed-role simplification — see module docstring). Production
    /// would gate on the protocol multisig that also controls the
    /// `AdjudicatorAllowlist`.
    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterAdjudicator>,
    authority: Pubkey,
    kind: AdjudicatorKind,
) -> Result<()> {
    // ── Auth — v1 collapsed ───────────────────────────────────────────────
    //
    // The signer must be the market creator. This matches the on-chain
    // identity baked into `Market.creator` at `initialize_market` time. The
    // long-term home for this gate is the protocol multisig that already
    // controls `AdjudicatorAllowlist.authority`; collapsing them for v1
    // mirrors `seed-localnet.mjs`'s convention. See module docstring.
    require_keys_eq!(
        ctx.accounts.signer.key(),
        ctx.accounts.market.creator,
        SoothAdjudicatorError::NotAuthority
    );

    // Reject the all-zero default authority — defense in depth so a
    // misconfigured registration cannot create an Adjudicator that anyone
    // could claim by submitting a `Pubkey::default()` signature.
    require_keys_neq!(
        authority,
        Pubkey::default(),
        SoothAdjudicatorError::AuthorityIsDefault
    );

    let market_key = ctx.accounts.market.key();
    let kind_u8 = kind.as_u8();

    let adjudicator = &mut ctx.accounts.adjudicator;
    adjudicator.market = market_key;
    adjudicator.authority = authority;
    adjudicator.kind = kind;
    adjudicator.attested_outcome = None;
    adjudicator.attested_at = None;
    adjudicator.bump = ctx.bumps.adjudicator;

    let now = Clock::get()?.unix_timestamp;
    emit!(AdjudicatorRegistered {
        market: market_key,
        adjudicator: adjudicator.key(),
        authority,
        kind: kind_u8,
        ts: now,
    });

    Ok(())
}
