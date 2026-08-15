//! `AdjudicatorEntry` — per-market resolution-authority record.
//!
//! A single PDA per market records the adjudicator identity + attestation
//! state.
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

    /// Forward-compat padding. Adding a field consumes bytes from here
    /// instead of changing the account's length, so no migration is needed:
    /// Solana accounts are fixed-length buffers, and an `#[account]` struct
    /// that outgrows its buffer fails to deserialize on every instruction
    /// that loads it. (Unlike EVM, where appending a storage slot is free.)
    ///
    /// When you add a field, shrink this by exactly its serialized size and
    /// leave `SPACE` unchanged.
    pub _reserved: [u8; 64],
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
        + 1                        // bump
        + 64; // _reserved

    pub fn is_attested(&self) -> bool {
        self.attested_outcome.is_some()
    }

    pub fn is_disputed(&self) -> bool {
        self.disputed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh entry for the state-shape assertions below. The register /
    /// attest / dispute flow is exercised against the real on-chain
    /// instructions in the SDK's `tests/adjudicator-flow.test.ts`; these
    /// tests cover only the account layout.
    fn fresh() -> AdjudicatorEntry {
        let authority = Pubkey::new_unique();
        AdjudicatorEntry {
            market: Pubkey::new_unique(),
            authority,
            // v1 collapses the two roles at register time.
            dispute_authority: authority,
            attested_outcome: None,
            attested_at: None,
            disputed: false,
            disputed_at: None,
            bump: 254,
            _reserved: [0; 64],
        }
    }

    #[test]
    fn space_constant_is_self_consistent() {
        // Anchor's `init` rents exactly SPACE bytes and never re-checks it
        // against the struct. A field added without bumping this under-rents
        // the account, and the failure shows up as a deserialize error much
        // later, on a different instruction.
        let expected = 8   // discriminator
            + 32           // market
            + 32           // authority
            + 32           // dispute_authority
            + 1 + 1        // attested_outcome: Option<u8>
            + 1 + 8        // attested_at: Option<i64>
            + 1            // disputed: bool
            + 1 + 8        // disputed_at: Option<i64>
            + 1            // bump
            + 64; // _reserved
        assert_eq!(AdjudicatorEntry::SPACE, expected);
        assert_eq!(AdjudicatorEntry::SPACE, 190);
    }

    #[test]
    fn a_fresh_entry_is_neither_attested_nor_disputed() {
        let adj = fresh();
        assert!(!adj.is_attested());
        assert!(!adj.is_disputed());
        assert!(adj.attested_at.is_none());
        assert!(adj.disputed_at.is_none());
    }

    #[test]
    fn is_attested_tracks_the_outcome_not_the_timestamp() {
        // `dispute` reads `is_attested()` as its precondition, so what this
        // predicate keys on decides whether that guard is reachable at all.
        let mut adj = fresh();
        adj.attested_at = Some(1_700_000_000);
        assert!(
            !adj.is_attested(),
            "a timestamp alone must not count as attested"
        );
        adj.attested_outcome = Some(1);
        assert!(adj.is_attested());
    }

    #[test]
    fn outcome_zero_counts_as_attested() {
        // OUTCOME_NO is 0. A `> 0` or truthiness check anywhere in this path
        // would silently treat a NO resolution as unattested.
        let mut adj = fresh();
        adj.attested_outcome = Some(0);
        assert!(adj.is_attested());
    }
}
