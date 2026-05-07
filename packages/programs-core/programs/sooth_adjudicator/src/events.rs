//! Events emitted by `sooth_adjudicator`.
//!
//! Solana logs are best-effort (architecture §3); indexers must subscribe
//! live or rely on the Geyser/webhook pipeline.

use anchor_lang::prelude::*;

/// Emitted by `register_adjudicator` when a new per-market `Adjudicator` PDA
/// is created. Mirrors EVM `AdjudicatorBase.MarketConfigured`.
#[event]
pub struct AdjudicatorRegistered {
    pub market: Pubkey,
    pub adjudicator: Pubkey,
    pub authority: Pubkey,
    /// Encoded `AdjudicatorKind` discriminant — 0 = Manual, 1 = ZkTLS,
    /// 2 = Other(_). Indexers parse this against `state::adjudicator::AdjudicatorKind`.
    pub kind: u8,
    pub ts: i64,
}

/// Emitted by `attest_outcome` when the per-market authority signs the
/// resolution. Mirrors EVM `AdjudicatorBase.OutcomeAttested`.
#[event]
pub struct OutcomeAttested {
    pub market: Pubkey,
    pub adjudicator: Pubkey,
    /// 0=NO, 1=YES, 2=INVALID per protocol-wide OUTCOME encoding.
    pub winning_outcome: u8,
    pub ts: i64,
}

/// Emitted by `dispute` when the `dispute_authority` overrides an attested
/// outcome. Mirrors EVM `AdjudicatorBase.MarketDisputed` — `previous_outcome`
/// + `new_outcome` give indexers the full audit trail of the override.
#[event]
pub struct DisputeRaised {
    pub market: Pubkey,
    pub adjudicator: Pubkey,
    pub disputer: Pubkey,
    /// Outcome recorded by the original `attest_outcome` call. Indexers
    /// compare this against `new_outcome` to flag identity-overrides
    /// (where the dispute confirms the original outcome).
    pub previous_outcome: u8,
    /// Outcome the `dispute_authority` is asserting. `0=NO, 1=YES,
    /// 2=INVALID` per protocol-wide OUTCOME encoding.
    pub new_outcome: u8,
    pub ts: i64,
}
