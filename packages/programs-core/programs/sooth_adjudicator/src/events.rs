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

/// Emitted by the (stub) `dispute` ix. Architecture §4.4 sketches a veto
/// branch on dispute; the v1 ix is `todo!()` so the event lives here for
/// IDL stability — wired indexers can match against it once the body lands.
#[event]
pub struct DisputeRaised {
    pub market: Pubkey,
    pub adjudicator: Pubkey,
    pub disputer: Pubkey,
    pub ts: i64,
}
