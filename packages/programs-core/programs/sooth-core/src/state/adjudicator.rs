//! `AdjudicatorEntry` — per-market resolution-authority record.
//!
//! This replaces both `sooth_market::AdjudicatorAllowlist` (the old singleton
//! allowlist) and `sooth_adjudicator::Adjudicator` (the old per-market PDA
//! in a separate program). In the merged `sooth_core`, a single PDA per
//! market records the adjudicator identity + attestation state.
//!
//! ## PDA seed convention
//!
//! Seeds = `[b"adjudicator", market_pubkey]`, derived under `sooth_core::ID`.

use anchor_lang::prelude::*;

/// PDA seed for the per-market adjudicator record.
pub const ADJUDICATOR_ENTRY_SEED: &[u8] = b"adjudicator";

#[account]
pub struct AdjudicatorEntry {
    /// `sooth_core::Market` account this adjudicator resolves.
    pub market: Pubkey,

    /// Authority gating `attest_outcome`. MUST be non-default.
    pub authority: Pubkey,

    /// Authority gating the `dispute` veto path. Defaults to `authority` at
    /// register time; can be rotated to a guardian multisig via a future ix.
    pub dispute_authority: Pubkey,

    /// Recorded outcome iff the authority has called `attest_outcome` (or
    /// the `dispute` veto path has overridden it). 0=NO, 1=YES, 2=INVALID.
    pub attested_outcome: Option<u8>,

    /// Unix-seconds timestamp of the original attestation.
    pub attested_at: Option<i64>,

    /// One-shot guard: once `dispute` mutates `attested_outcome` this is set
    /// true and subsequent disputes are rejected.
    pub disputed: bool,

    /// Unix-seconds timestamp of the dispute. `None` if not yet disputed.
    pub disputed_at: Option<i64>,

    /// Bump for the `AdjudicatorEntry` PDA.
    pub bump: u8,
}

impl AdjudicatorEntry {
    /// Borsh-serialized size for rent calculation.
    pub const SPACE: usize = 8     // discriminator
        + 32                       // market
        + 32                       // authority
        + 32                       // dispute_authority
        + (1 + 1)                  // attested_outcome: Option<u8>
        + (1 + 8)                  // attested_at: Option<i64>
        + 1                        // disputed: bool
        + (1 + 8)                  // disputed_at: Option<i64>
        + 1; // bump

    pub fn is_attested(&self) -> bool {
        self.attested_outcome.is_some()
    }

    pub fn is_disputed(&self) -> bool {
        self.disputed
    }
}
