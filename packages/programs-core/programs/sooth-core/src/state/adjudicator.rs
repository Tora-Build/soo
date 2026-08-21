//! `AdjudicatorEntry` — per-market resolution-authority record.
//!
//! A single PDA per market records the adjudicator identity + attestation
//! state.
//!
//! ## PDA seed convention
//!
//! Seeds = `[b"adjudicator", market_pubkey]`, derived under `sooth_core::ID`.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::zk::{EvmAddress, ZkComparator, ZkRule};

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

    // ── zkTLS adjudication ───────────────────────────────────────────────
    //
    // Carved out of `_reserved`, so the account length is unchanged and no
    // migration is needed. Every one of these reads as zero on an entry
    // written by `register_adjudicator`, and zero means "manual" — see
    // `zk_comparator`.

    /// How the attested value is tested against `zk_threshold`, and — because
    /// `ZkComparator::None` is discriminant zero — whether this entry is
    /// zk-enabled at all. An entry from the manual `register_adjudicator`
    /// path has a zeroed reserved region and therefore reads as `None`,
    /// which is what keeps `attest_outcome_zk` off every existing market.
    pub zk_comparator: u8,

    /// Decimal places the attested value and `zk_threshold` share. An
    /// attested value carrying more fractional digits than this is rejected
    /// rather than truncated.
    pub zk_value_scale: u8,

    /// The single EVM address whose signature over a Primus attestation this
    /// market accepts.
    pub zk_attestor_evm: EvmAddress,

    /// Commitment to the attestation's request url and responseResolve
    /// parsePath. It is what stops an attestation for a different endpoint,
    /// or a different field of the same endpoint, from being substituted —
    /// the signature alone only proves the attestor saw *something*.
    /// Composition: `crate::zk::compute_rule_hash`.
    pub zk_rule_hash: [u8; 32],

    /// Threshold in `10^zk_value_scale` units.
    pub zk_threshold: i64,

    /// Forward-compat padding. Adding a field consumes bytes from here
    /// instead of changing the account's length, so no migration is needed:
    /// Solana accounts are fixed-length buffers, and an `#[account]` struct
    /// that outgrows its buffer fails to deserialize on every instruction
    /// that loads it. (Unlike EVM, where appending a storage slot is free.)
    ///
    /// When you add a field, shrink this by exactly its serialized size and
    /// leave `SPACE` unchanged. The zk block above consumed 62 of the
    /// original 64 bytes, so the next field larger than two bytes needs a
    /// separate PDA rather than this region.
    pub _reserved: [u8; 2],
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
        + 1                        // zk_comparator
        + 1                        // zk_value_scale
        + 20                       // zk_attestor_evm
        + 32                       // zk_rule_hash
        + 8                        // zk_threshold
        + 2; // _reserved

    pub fn is_attested(&self) -> bool {
        self.attested_outcome.is_some()
    }

    pub fn is_disputed(&self) -> bool {
        self.disputed
    }

    /// True iff `register_zk_adjudicator` configured this entry. Keyed on the
    /// comparator because that is the field whose zero value is unusable:
    /// a zero attestor address or rule hash could in principle be a real (if
    /// absurd) configuration, whereas `ZkComparator::None` resolves nothing.
    pub fn is_zk_enabled(&self) -> bool {
        self.zk_comparator != ZkComparator::None as u8
    }

    /// The comparator as a typed value, erroring on a discriminant no
    /// released version ever wrote.
    pub fn comparator(&self) -> Result<ZkComparator> {
        ZkComparator::from_u8(self.zk_comparator)
    }

    /// The zk fields as a `ZkRule`, or `ZkNotEnabled`. They come out together
    /// because verifying against any subset of them is a bug: the signature
    /// without the rule hash proves only that the attestor saw something.
    pub fn require_zk_rule(&self) -> Result<ZkRule> {
        require!(self.is_zk_enabled(), SoothCoreError::ZkNotEnabled);
        Ok(ZkRule {
            attestor_evm: self.zk_attestor_evm,
            rule_hash: self.zk_rule_hash,
            comparator: self.comparator()?,
            threshold: self.zk_threshold as i128,
            value_scale: self.zk_value_scale,
        })
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
            zk_comparator: ZkComparator::None as u8,
            zk_value_scale: 0,
            zk_attestor_evm: [0; 20],
            zk_rule_hash: [0; 32],
            zk_threshold: 0,
            _reserved: [0; 2],
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
            + 1            // zk_comparator
            + 1            // zk_value_scale
            + 20           // zk_attestor_evm
            + 32           // zk_rule_hash
            + 8            // zk_threshold
            + 2; // _reserved
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
    fn a_manually_registered_entry_is_not_zk_enabled() {
        // The zk block is carved from a reserved region that
        // `register_adjudicator` leaves zeroed, so every entry that path ever
        // wrote — including ones already on devnet — must read as manual.
        let adj = fresh();
        assert!(!adj.is_zk_enabled());
        assert!(adj.require_zk_rule().is_err());
    }

    #[test]
    fn any_nonzero_comparator_enables_zk() {
        let mut adj = fresh();
        for c in [
            ZkComparator::Gt,
            ZkComparator::Gte,
            ZkComparator::Lt,
            ZkComparator::Lte,
            ZkComparator::Eq,
        ] {
            adj.zk_comparator = c as u8;
            assert!(adj.is_zk_enabled());
            assert_eq!(adj.comparator().unwrap(), c);
        }
    }

    #[test]
    fn an_unknown_comparator_discriminant_is_rejected_not_defaulted() {
        // Defaulting an unknown discriminant to some comparator would let a
        // future account shape silently resolve markets the wrong way.
        let mut adj = fresh();
        adj.zk_comparator = 9;
        assert!(adj.comparator().is_err());
        assert!(adj.require_zk_rule().is_err());
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
