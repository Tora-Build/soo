//! `Adjudicator` — per-market resolution-authority record.
//!
//! Architecture §4.4 + §7. EVM analogue: a stored `MarketState` row inside
//! one of the per-type adjudicator contracts (e.g. `ManualAdjudicator`),
//! keyed by market address. On Solana we collapse that into a single PDA
//! per (program, market) pair owned by `sooth_adjudicator`.
//!
//! ## PDA seed convention
//!
//! Seeds = `[b"adjudicator", market_pubkey]`, derived under
//! `sooth_adjudicator::ID`. The `market_pubkey` is `sooth_market::Market.key()`
//! (NOT `market_id` — Anchor `Account<'info, Market>` accounts in the CPI
//! exchange already resolve to keys, so binding by key keeps the lookup one
//! `find_program_address` call rather than two seeds + bump indirection).
//!
//! ## Variants (Manual / ZkTLS / Other)
//!
//! - `Manual` — v1 production path. A designated `authority: Pubkey` signs
//!   `attest_outcome` to record the resolved outcome. Mirrors EVM
//!   `ManualAdjudicator` (`sooth-alpha/.../adjudicators/ManualAdjudicator.sol`):
//!   `_requiresAttestation() = false` semantics, with the on-chain authority
//!   replacing EVM's `onlyOwner` modifier.
//!
//! - `ZkTLS` — placeholder. EVM uses Primus's `PrimusZKTLS` proxy on Base
//!   Sepolia; no Solana program as of 2026-05 (architecture §7). The kind is
//!   encoded so the IDL/account layout is stable, but `attest_outcome`
//!   rejects `ZkTLS` with `UnsupportedKind` until a verifier program lands.
//!   Phased plan: integrate Reclaim or wait for Primus Solana support
//!   (architecture §7).
//!
//! - `Other(u8)` — tag-only escape hatch for forks / future variants. Same
//!   `UnsupportedKind` rejection in `attest_outcome` — the variant exists so
//!   adding a new adjudicator type doesn't require a new account-layout
//!   migration.

use anchor_lang::prelude::*;

/// PDA seed prefix for the per-market adjudicator record.
pub const ADJUDICATOR_SEED: &[u8] = b"adjudicator";

/// Adjudicator implementation kind. v1 ships with `Manual` only — the other
/// variants are tag-stable placeholders so a future kind add doesn't require
/// rewriting the account layout. See module-level docstring for the per-
/// variant rationale.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AdjudicatorKind {
    /// v1 production path — designated authority pubkey gates `attest_outcome`.
    Manual,
    /// Placeholder for the ZkTLS variant. Rejected by `attest_outcome` with
    /// `UnsupportedKind` until a verifier program lands. EVM precedent:
    /// `ZkTLSAdjudicator` backed by `PrimusZKTLS`.
    ZkTLS,
    /// Tag-only escape hatch for fork-defined or future adjudicator types.
    /// The wrapped `u8` is a free-form discriminator — `sooth_adjudicator`
    /// doesn't interpret it; consumers can add a sibling program that reads
    /// this tag and dispatches accordingly. Rejected here with `UnsupportedKind`.
    Other(u8),
}

impl AdjudicatorKind {
    /// Borsh-encoded size for `Adjudicator::SPACE`.
    /// 1 byte enum tag + worst-case 1 byte payload (`Other(u8)`).
    pub const SPACE: usize = 1 + 1;

    /// Compact `u8` discriminant used in `AdjudicatorRegistered` events.
    /// Indexers should decode against this table.
    pub fn as_u8(&self) -> u8 {
        match self {
            AdjudicatorKind::Manual => 0,
            AdjudicatorKind::ZkTLS => 1,
            AdjudicatorKind::Other(_) => 2,
        }
    }
}

#[account]
pub struct Adjudicator {
    /// `sooth_market::Market` account this adjudicator resolves. Bound at
    /// `register_adjudicator` time; the per-market PDA seed includes this
    /// pubkey (see module docstring for seed shape).
    pub market: Pubkey,

    /// Authority gating `attest_outcome` for the `Manual` variant. For
    /// `ZkTLS` / `Other` variants this is set but unused in v1 (the verifier
    /// program would replace authority-signing with proof verification).
    /// MUST be non-default — `register_adjudicator` rejects `Pubkey::default()`.
    pub authority: Pubkey,

    /// Authority gating the `dispute` veto path. Defaults to `authority` at
    /// `register_adjudicator` time (collapsed v1 role) but is stored as a
    /// separate field so production can rotate it to a guardian multisig
    /// without re-registering the market. EVM analogue: the per-adjudicator
    /// guardian whitelist on `AdjudicatorBase` (`_guardians` mapping); v1
    /// collapses that whitelist to a single Pubkey for simplicity. MUST be
    /// non-default — `register_adjudicator` rejects `Pubkey::default()`.
    pub dispute_authority: Pubkey,

    /// Variant tag. v1 only services `Manual`; `ZkTLS` / `Other` are
    /// placeholders rejected at attest-time with `UnsupportedKind`.
    pub kind: AdjudicatorKind,

    /// Recorded outcome iff the authority has called `attest_outcome` (or
    /// the `dispute` veto path has overridden it). 0=NO, 1=YES, 2=INVALID
    /// per protocol-wide OUTCOME encoding (see `glossary.md`). Read by
    /// `sooth_market::settle` via the CPI handshake — settle accepts only
    /// the introspection-verified `attest_outcome` or `dispute` parent ixs
    /// and trusts the outcome the chosen parent committed.
    pub attested_outcome: Option<u8>,

    /// Unix-seconds timestamp of the original attestation. Populated by
    /// `attest_outcome` and NOT overwritten by `dispute` — useful for
    /// indexers reconstructing the resolve → attest → dispute → settle
    /// timeline.
    pub attested_at: Option<i64>,

    /// One-shot guard: once `dispute` mutates `attested_outcome`, this flag
    /// is set true and a subsequent `dispute` (or `attest_outcome`, which
    /// is also gated on `!is_attested()`) is rejected. Settle remains the
    /// terminal action; once it runs the market lifecycle locks the outcome
    /// regardless of this flag.
    pub disputed: bool,

    /// Unix-seconds timestamp of the dispute, populated alongside `disputed`.
    /// `None` if `dispute` has not been called. Stored even though v1
    /// enforces no time window so a future veto-window upgrade can read the
    /// timestamp without a fresh account-layout migration.
    pub disputed_at: Option<i64>,

    /// Bump for the `Adjudicator` PDA itself.
    pub bump: u8,
}

impl Adjudicator {
    /// Borsh-serialized size for rent calculation. Anchor's 8-byte
    /// discriminator is added by `#[account]`. Update if fields change.
    pub const SPACE: usize = 8     // discriminator
        + 32                       // market
        + 32                       // authority
        + 32                       // dispute_authority
        + AdjudicatorKind::SPACE   // kind
        + 1 + 1                    // attested_outcome: Option<u8>: tag + payload
        + 1 + 8                    // attested_at: Option<i64>: tag + payload
        + 1                        // disputed: bool
        + 1 + 8                    // disputed_at: Option<i64>: tag + payload
        + 1; // bump

    pub fn is_attested(&self) -> bool {
        self.attested_outcome.is_some()
    }

    pub fn is_disputed(&self) -> bool {
        self.disputed
    }
}
