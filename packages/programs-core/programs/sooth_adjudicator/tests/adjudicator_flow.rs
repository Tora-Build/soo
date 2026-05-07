//! Host-side unit tests for `Adjudicator` state shape + the predicate logic
//! that the on-chain handlers in `register_adjudicator` / `attest_outcome` /
//! `dispute` rely on.
//!
//! These run under regular `cargo test -p sooth_adjudicator` (no SBF, no
//! BanksClient). The handlers themselves are thin wrappers around these
//! invariants; full ix-level tests require a live validator and live in
//! the workspace's TS integration suite (or a future `tests/anchor/` Rust
//! BanksClient harness — same convention as `sooth_market::tests/`).
//!
//! Coverage:
//!   - `AdjudicatorKind::as_u8` discriminant table (event payload contract)
//!   - `Adjudicator::SPACE` is self-consistent with the layout
//!   - `Adjudicator::is_attested` reflects `attested_outcome`
//!   - The predicate flow `register → attest → state-machine` mirrors the
//!     handler, exercised in-memory.

use anchor_lang::prelude::Pubkey;
use sooth_adjudicator::state::{Adjudicator, AdjudicatorKind};

fn fresh_adjudicator() -> Adjudicator {
    let authority = Pubkey::new_unique();
    Adjudicator {
        market: Pubkey::new_unique(),
        authority,
        // v1 collapsed-role: dispute_authority defaults to the attestation
        // authority. Tests that exercise the separate-authority case
        // override this field directly.
        dispute_authority: authority,
        kind: AdjudicatorKind::Manual,
        attested_outcome: None,
        attested_at: None,
        disputed: false,
        disputed_at: None,
        bump: 254,
    }
}

#[test]
fn adjudicator_kind_discriminants_are_stable() {
    // The `AdjudicatorRegistered` event encodes `kind` as `u8`; indexers
    // decode against this table. A reorder here is a wire-break.
    assert_eq!(AdjudicatorKind::Manual.as_u8(), 0);
    assert_eq!(AdjudicatorKind::ZkTLS.as_u8(), 1);
    assert_eq!(AdjudicatorKind::Other(7).as_u8(), 2);
    assert_eq!(AdjudicatorKind::Other(255).as_u8(), 2);
}

#[test]
fn adjudicator_kind_space_constant_matches_layout() {
    // 1 byte enum tag + 1 byte payload (worst-case `Other(u8)`).
    assert_eq!(AdjudicatorKind::SPACE, 2);
}

#[test]
fn adjudicator_space_constant_is_self_consistent() {
    // Recompute SPACE from first principles. Anchor's rent calc trusts
    // SPACE; a mismatch would silently under-rent the account. Layout:
    //
    //   discriminator        8
    //   market              32
    //   authority           32
    //   dispute_authority   32
    //   kind                 2  (AdjudicatorKind::SPACE)
    //   attested_outcome     2  (Option<u8>: tag + u8)
    //   attested_at          9  (Option<i64>: tag + i64)
    //   disputed             1  (bool)
    //   disputed_at          9  (Option<i64>: tag + i64)
    //   bump                 1
    //                       ── = 128
    let expected = 8        // discriminator
        + 32                // market
        + 32                // authority
        + 32                // dispute_authority
        + AdjudicatorKind::SPACE
        + 1 + 1             // Option<u8>: tag + u8
        + 1 + 8             // Option<i64>: tag + i64
        + 1                 // disputed: bool
        + 1 + 8             // Option<i64>: tag + i64
        + 1; // bump
    assert_eq!(Adjudicator::SPACE, expected);
    assert_eq!(Adjudicator::SPACE, 128);
}

#[test]
fn fresh_adjudicator_is_not_attested() {
    let adj = fresh_adjudicator();
    assert!(!adj.is_attested());
    assert!(adj.attested_outcome.is_none());
    assert!(adj.attested_at.is_none());
}

#[test]
fn attested_adjudicator_is_attested() {
    let mut adj = fresh_adjudicator();
    adj.attested_outcome = Some(1);
    adj.attested_at = Some(1_700_000_000);
    assert!(adj.is_attested());
}

// ─── Predicate-level mirrors of the on-chain handlers ────────────────────
//
// We replicate the handler bodies inline (they are short and pure once you
// strip the `Context` ceremony) so we can drive them with direct struct
// mutation. The on-chain handlers in `instructions/{register,attest}*.rs`
// must stay in lock-step with these helpers — if/when this drifts, the
// integration suite (TS, against a live validator) will catch the gap.

const OUTCOME_NO: u8 = 0;
const OUTCOME_YES: u8 = 1;
const OUTCOME_INVALID: u8 = 2;

fn register(
    market: Pubkey,
    authority: Pubkey,
    kind: AdjudicatorKind,
) -> std::result::Result<Adjudicator, &'static str> {
    if authority == Pubkey::default() {
        return Err("AuthorityIsDefault");
    }
    Ok(Adjudicator {
        market,
        authority,
        // v1: dispute_authority defaults to authority. Mirrors the on-chain
        // handler in `register_adjudicator`.
        dispute_authority: authority,
        kind,
        attested_outcome: None,
        attested_at: None,
        disputed: false,
        disputed_at: None,
        bump: 254,
    })
}

fn attest(
    adj: &mut Adjudicator,
    signer: Pubkey,
    winning_outcome: u8,
    now: i64,
) -> Result<(), &'static str> {
    if !matches!(winning_outcome, OUTCOME_NO | OUTCOME_YES | OUTCOME_INVALID) {
        return Err("InvalidOutcome");
    }
    if !matches!(adj.kind, AdjudicatorKind::Manual) {
        return Err("UnsupportedKind");
    }
    if signer != adj.authority {
        return Err("NotAuthority");
    }
    if adj.attested_outcome.is_some() {
        return Err("AlreadyAttested");
    }
    adj.attested_outcome = Some(winning_outcome);
    adj.attested_at = Some(now);
    Ok(())
}

#[test]
fn register_rejects_default_authority() {
    let market = Pubkey::new_unique();
    let res = register(market, Pubkey::default(), AdjudicatorKind::Manual);
    match res {
        Err(msg) => assert_eq!(msg, "AuthorityIsDefault"),
        Ok(_) => panic!("expected AuthorityIsDefault rejection"),
    }
}

#[test]
fn register_creates_unattested_record() {
    let market = Pubkey::new_unique();
    let auth = Pubkey::new_unique();
    let adj = register(market, auth, AdjudicatorKind::Manual).unwrap();
    assert_eq!(adj.market, market);
    assert_eq!(adj.authority, auth);
    assert!(matches!(adj.kind, AdjudicatorKind::Manual));
    assert!(!adj.is_attested());
}

#[test]
fn attest_happy_path() {
    let market = Pubkey::new_unique();
    let auth = Pubkey::new_unique();
    let mut adj = register(market, auth, AdjudicatorKind::Manual).unwrap();

    attest(&mut adj, auth, OUTCOME_YES, 1_700_000_000).unwrap();
    assert_eq!(adj.attested_outcome, Some(OUTCOME_YES));
    assert_eq!(adj.attested_at, Some(1_700_000_000));
}

#[test]
fn attest_rejects_invalid_outcome() {
    let auth = Pubkey::new_unique();
    let mut adj = register(Pubkey::new_unique(), auth, AdjudicatorKind::Manual).unwrap();
    let err = attest(&mut adj, auth, 9, 0).unwrap_err();
    assert_eq!(err, "InvalidOutcome");
    assert!(!adj.is_attested());
}

#[test]
fn attest_rejects_zk_tls_in_v1() {
    let auth = Pubkey::new_unique();
    let mut adj = register(Pubkey::new_unique(), auth, AdjudicatorKind::ZkTLS).unwrap();
    let err = attest(&mut adj, auth, OUTCOME_YES, 0).unwrap_err();
    assert_eq!(err, "UnsupportedKind");
}

#[test]
fn attest_rejects_other_variant_in_v1() {
    let auth = Pubkey::new_unique();
    let mut adj = register(Pubkey::new_unique(), auth, AdjudicatorKind::Other(42)).unwrap();
    let err = attest(&mut adj, auth, OUTCOME_NO, 0).unwrap_err();
    assert_eq!(err, "UnsupportedKind");
}

#[test]
fn attest_rejects_wrong_signer() {
    let auth = Pubkey::new_unique();
    let attacker = Pubkey::new_unique();
    let mut adj = register(Pubkey::new_unique(), auth, AdjudicatorKind::Manual).unwrap();
    let err = attest(&mut adj, attacker, OUTCOME_YES, 0).unwrap_err();
    assert_eq!(err, "NotAuthority");
}

#[test]
fn attest_is_idempotent_single_shot() {
    // Attest succeeds the first time; second attempt is rejected.
    let auth = Pubkey::new_unique();
    let mut adj = register(Pubkey::new_unique(), auth, AdjudicatorKind::Manual).unwrap();
    attest(&mut adj, auth, OUTCOME_YES, 1_000).unwrap();
    let err = attest(&mut adj, auth, OUTCOME_NO, 2_000).unwrap_err();
    assert_eq!(err, "AlreadyAttested");
    // First-attestation outcome must remain.
    assert_eq!(adj.attested_outcome, Some(OUTCOME_YES));
    assert_eq!(adj.attested_at, Some(1_000));
}

#[test]
fn attest_accepts_invalid_outcome_per_protocol() {
    // OUTCOME_INVALID = 2 is a valid resolution per the protocol-wide
    // encoding (mirrors EVM `TruthMarket.invalidate` semantics).
    let auth = Pubkey::new_unique();
    let mut adj = register(Pubkey::new_unique(), auth, AdjudicatorKind::Manual).unwrap();
    attest(&mut adj, auth, OUTCOME_INVALID, 0).unwrap();
    assert_eq!(adj.attested_outcome, Some(OUTCOME_INVALID));
}

// ─── Dispute predicate ───────────────────────────────────────────────────
//
// Same shape as `attest` above — replicates the on-chain handler's body
// inline so the host-side tests can drive each branch with direct struct
// mutation. The on-chain handler in `instructions/dispute.rs` must stay
// in lock-step with this helper. Mirrors the EVM `AdjudicatorBase.dispute`
// flow but collapsed for v1: no time window, single dispute_authority
// pubkey instead of a guardian whitelist.
fn dispute(
    adj: &mut Adjudicator,
    market_settled: bool,
    signer: Pubkey,
    new_outcome: u8,
    now: i64,
) -> Result<(), &'static str> {
    if !matches!(new_outcome, OUTCOME_NO | OUTCOME_YES | OUTCOME_INVALID) {
        return Err("InvalidOutcome");
    }
    if market_settled {
        return Err("MarketAlreadySettled");
    }
    if adj.attested_outcome.is_none() {
        return Err("NotAttested");
    }
    if adj.disputed {
        return Err("AlreadyDisputed");
    }
    if signer != adj.dispute_authority {
        return Err("NotDisputeAuthority");
    }
    adj.attested_outcome = Some(new_outcome);
    adj.disputed = true;
    adj.disputed_at = Some(now);
    Ok(())
}

#[test]
fn dispute_happy_path_overrides_outcome_to_invalid() {
    // Canonical EVM-style "force invalidation" — original attestation YES,
    // dispute flips to INVALID.
    let auth = Pubkey::new_unique();
    let mut adj = register(Pubkey::new_unique(), auth, AdjudicatorKind::Manual).unwrap();
    attest(&mut adj, auth, OUTCOME_YES, 1_000).unwrap();

    dispute(&mut adj, false, auth, OUTCOME_INVALID, 2_000).unwrap();
    assert_eq!(adj.attested_outcome, Some(OUTCOME_INVALID));
    assert!(adj.is_disputed());
    assert_eq!(adj.disputed_at, Some(2_000));
    // attested_at preserved as the original-attestation timestamp.
    assert_eq!(adj.attested_at, Some(1_000));
}

#[test]
fn dispute_happy_path_overrides_outcome_to_other_valid() {
    // The EVM model also allows a guardian-supplied alternative outcome —
    // not just INVALID. v1 supports the same: dispute can flip YES→NO.
    let auth = Pubkey::new_unique();
    let mut adj = register(Pubkey::new_unique(), auth, AdjudicatorKind::Manual).unwrap();
    attest(&mut adj, auth, OUTCOME_YES, 1_000).unwrap();

    dispute(&mut adj, false, auth, OUTCOME_NO, 2_000).unwrap();
    assert_eq!(adj.attested_outcome, Some(OUTCOME_NO));
    assert!(adj.is_disputed());
}

#[test]
fn dispute_rejects_invalid_outcome() {
    let auth = Pubkey::new_unique();
    let mut adj = register(Pubkey::new_unique(), auth, AdjudicatorKind::Manual).unwrap();
    attest(&mut adj, auth, OUTCOME_YES, 0).unwrap();

    let err = dispute(&mut adj, false, auth, 9, 0).unwrap_err();
    assert_eq!(err, "InvalidOutcome");
    // Original outcome preserved.
    assert_eq!(adj.attested_outcome, Some(OUTCOME_YES));
    assert!(!adj.is_disputed());
}

#[test]
fn dispute_rejects_when_market_already_settled() {
    // Once `settle` has run on the market the lifecycle is terminal — a
    // late dispute would be a soundness break. This predicate mirrors the
    // on-chain handler's `MarketAlreadySettled` check.
    let auth = Pubkey::new_unique();
    let mut adj = register(Pubkey::new_unique(), auth, AdjudicatorKind::Manual).unwrap();
    attest(&mut adj, auth, OUTCOME_YES, 0).unwrap();

    let err = dispute(&mut adj, true, auth, OUTCOME_INVALID, 0).unwrap_err();
    assert_eq!(err, "MarketAlreadySettled");
    assert!(!adj.is_disputed());
}

#[test]
fn dispute_rejects_before_attestation() {
    // Nothing to dispute — the resolve/attest leg is the canonical first
    // leg. Without `attested_outcome.is_some()` the dispute path is moot.
    let auth = Pubkey::new_unique();
    let mut adj = register(Pubkey::new_unique(), auth, AdjudicatorKind::Manual).unwrap();

    let err = dispute(&mut adj, false, auth, OUTCOME_INVALID, 0).unwrap_err();
    assert_eq!(err, "NotAttested");
}

#[test]
fn dispute_is_one_shot_per_market() {
    // Mirrors `attest`'s single-shot guard. Once dispute has overridden
    // the outcome, a second dispute is rejected. EVM semantics return the
    // market to ACTIVE for re-resolve; v1 collapses that to "the dispute
    // *is* the new attestation" — so the lock is permanent.
    let auth = Pubkey::new_unique();
    let mut adj = register(Pubkey::new_unique(), auth, AdjudicatorKind::Manual).unwrap();
    attest(&mut adj, auth, OUTCOME_YES, 0).unwrap();
    dispute(&mut adj, false, auth, OUTCOME_INVALID, 1_000).unwrap();

    let err = dispute(&mut adj, false, auth, OUTCOME_NO, 2_000).unwrap_err();
    assert_eq!(err, "AlreadyDisputed");
    // First-dispute outcome must remain.
    assert_eq!(adj.attested_outcome, Some(OUTCOME_INVALID));
    assert_eq!(adj.disputed_at, Some(1_000));
}

#[test]
fn dispute_rejects_wrong_signer() {
    let auth = Pubkey::new_unique();
    let attacker = Pubkey::new_unique();
    let mut adj = register(Pubkey::new_unique(), auth, AdjudicatorKind::Manual).unwrap();
    attest(&mut adj, auth, OUTCOME_YES, 0).unwrap();

    let err = dispute(&mut adj, false, attacker, OUTCOME_INVALID, 0).unwrap_err();
    assert_eq!(err, "NotDisputeAuthority");
    assert_eq!(adj.attested_outcome, Some(OUTCOME_YES));
    assert!(!adj.is_disputed());
}

#[test]
fn dispute_separate_authority_can_override_attest_authority() {
    // Production-mode: `dispute_authority` is rotated to a separate guardian
    // multisig pubkey while the attestation `authority` remains the
    // operational resolver. The attest authority signs `attest_outcome`
    // but CANNOT sign `dispute`; the guardian signs `dispute` but CANNOT
    // sign `attest_outcome`. v1 stores both so this rotation is a single
    // field write rather than an account migration.
    let attest_auth = Pubkey::new_unique();
    let guardian = Pubkey::new_unique();
    let mut adj = register(Pubkey::new_unique(), attest_auth, AdjudicatorKind::Manual).unwrap();
    // Simulate post-register rotation of dispute_authority to the guardian.
    adj.dispute_authority = guardian;

    // The attest authority can still attest.
    attest(&mut adj, attest_auth, OUTCOME_YES, 0).unwrap();

    // The attest authority CANNOT dispute.
    let err = dispute(&mut adj, false, attest_auth, OUTCOME_INVALID, 0).unwrap_err();
    assert_eq!(err, "NotDisputeAuthority");

    // The guardian CAN dispute.
    dispute(&mut adj, false, guardian, OUTCOME_INVALID, 1_000).unwrap();
    assert_eq!(adj.attested_outcome, Some(OUTCOME_INVALID));
    assert!(adj.is_disputed());
}

#[test]
fn register_defaults_dispute_authority_to_attest_authority() {
    // v1 collapsed-role: `register_adjudicator` populates `dispute_authority`
    // with the same pubkey as `authority`. Mirrors the on-chain handler.
    let auth = Pubkey::new_unique();
    let adj = register(Pubkey::new_unique(), auth, AdjudicatorKind::Manual).unwrap();
    assert_eq!(adj.authority, auth);
    assert_eq!(adj.dispute_authority, auth);
    assert!(!adj.disputed);
    assert!(adj.disputed_at.is_none());
}
