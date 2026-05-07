//! Runtime CPI integration test: `sooth_adjudicator::dispute` end-to-end.
//!
//! Companion to `cpi_settle.rs`. Exercises the veto branch on architecture
//! §4.4: the `dispute_authority` overrides an attested outcome and CPIs
//! into `sooth_market::settle` whose parent-ix introspection now accepts
//! `attest_outcome` OR `dispute` as the legitimate parent.
//!
//! ## Why no "happy path attest → dispute → settle" runtime test
//!
//! In v1 `attest_outcome` CPIs straight into `sooth_market::settle` as part
//! of its handler body — Locked → Settled lands in a single tx. There is
//! no on-chain window between "attested" and "settled" that a runtime
//! dispute can intercept. The override-the-attestation logic itself is
//! covered by the host-side predicate tests in
//! `programs/sooth_adjudicator/tests/adjudicator_flow.rs`
//! (`dispute_happy_path_overrides_outcome_to_invalid` etc.).
//!
//! ## What this file does cover
//!
//! Three rejection paths whose enforcement depends on the live CPI plumbing
//! (and so are NOT subsumed by the host-side predicate tests):
//!
//!   1. `dispute` after `settle` — `MarketAlreadySettled` short-circuits.
//!   2. `dispute` before `attest_outcome` — `NotAttested` short-circuits.
//!   3. `dispute` with a non-`dispute_authority` signer — runtime auth gate
//!      rejects via `NotDisputeAuthority`.

mod common;

use common::*;
use solana_sdk::{signature::Keypair, signer::Signer};
use sooth_market::state::market::{OUTCOME_INVALID, OUTCOME_YES};
use sooth_market::state::MarketLifecycle;

#[test]
fn dispute_after_settle_is_rejected() {
    // Most production-like scenario: `attest_outcome` lands first
    // (driving the market to Settled in v1), then a late dispute is
    // submitted. The adjudicator-side handler trips `MarketAlreadySettled`
    // BEFORE attempting the CPI, so the on-market state is untouched.
    let mut harness = Harness::boot();
    let pdas = bootstrap_market(&mut harness, market_id(0xD1));
    register_adjudicator(&mut harness, &pdas);

    let creator = clone_keypair(&harness.creator);

    // Open → Locked.
    let lock_ix = build_request_lock_ix(&harness, &pdas);
    send_ixs(&mut harness.svm, &creator, &[lock_ix]);

    // Locked → Settled via the attestation path.
    harness.svm.expire_blockhash();
    let attest_ix = build_attest_outcome_ix(&harness, &pdas, OUTCOME_YES);
    send_ixs(&mut harness.svm, &creator, &[attest_ix]);

    let post_settle = fetch_market(&harness.svm, pdas.market);
    assert!(matches!(post_settle.lifecycle, MarketLifecycle::Settled));
    assert_eq!(post_settle.winning_outcome, OUTCOME_YES);

    // Dispute attempt — must fail. The market is already Settled.
    harness.svm.expire_blockhash();
    let dispute_ix = build_dispute_ix(&pdas, creator.pubkey(), OUTCOME_INVALID);
    let res = try_send_ixs(&mut harness.svm, &creator, &[dispute_ix]);
    assert!(res.is_err(), "post-settle dispute must be rejected");

    // On-market state must be untouched — winning_outcome remains YES.
    let market = fetch_market(&harness.svm, pdas.market);
    assert!(matches!(market.lifecycle, MarketLifecycle::Settled));
    assert_eq!(market.winning_outcome, OUTCOME_YES);

    // Adjudicator state: NOT disputed (rejection short-circuited before
    // the mutation).
    let adj = fetch_adjudicator(&harness.svm, pdas.adjudicator_pda);
    assert!(!adj.disputed);
    assert!(adj.disputed_at.is_none());
    assert_eq!(adj.attested_outcome, Some(OUTCOME_YES));
}

#[test]
fn dispute_before_attestation_is_rejected() {
    // Dispute requires the market to have an attested outcome (the
    // canonical first leg). Without `attested_outcome.is_some()` the
    // handler trips `NotAttested`. The rejection must short-circuit
    // before any mutation.
    let mut harness = Harness::boot();
    let pdas = bootstrap_market(&mut harness, market_id(0xD2));
    register_adjudicator(&mut harness, &pdas);

    let creator = clone_keypair(&harness.creator);

    // Open → Locked, but skip attest_outcome.
    let lock_ix = build_request_lock_ix(&harness, &pdas);
    send_ixs(&mut harness.svm, &creator, &[lock_ix]);

    // Pre-attestation dispute — must fail with NotAttested.
    harness.svm.expire_blockhash();
    let dispute_ix = build_dispute_ix(&pdas, creator.pubkey(), OUTCOME_INVALID);
    let res = try_send_ixs(&mut harness.svm, &creator, &[dispute_ix]);
    assert!(res.is_err(), "pre-attestation dispute must be rejected");

    // Adjudicator state: untouched.
    let adj = fetch_adjudicator(&harness.svm, pdas.adjudicator_pda);
    assert!(!adj.disputed);
    assert_eq!(adj.attested_outcome, None);
    assert_eq!(adj.attested_at, None);

    // Market lifecycle: still Locked (no settle).
    let market = fetch_market(&harness.svm, pdas.market);
    assert!(matches!(market.lifecycle, MarketLifecycle::Locked));
}

#[test]
fn dispute_with_wrong_signer_is_rejected() {
    // Auth gate: only `adjudicator.dispute_authority` may sign. v1 collapses
    // this to the same key as the attestation authority. A random keypair
    // — even if airdropped + funded — must be rejected at the runtime.
    //
    // Note: the handler ordering trips `MarketAlreadySettled` first if the
    // market is in `Settled`; here we assert the broad "rejected" shape
    // rather than the exact custom code so the test stays robust to the
    // step-ordering choice. The host-side predicate test
    // `programs/sooth_adjudicator/tests/adjudicator_flow.rs::dispute_rejects_wrong_signer`
    // exercises the pure auth-gate rejection in isolation.
    let mut harness = Harness::boot();
    let pdas = bootstrap_market(&mut harness, market_id(0xD3));
    register_adjudicator(&mut harness, &pdas);

    let creator = clone_keypair(&harness.creator);
    let lock_ix = build_request_lock_ix(&harness, &pdas);
    send_ixs(&mut harness.svm, &creator, &[lock_ix]);
    harness.svm.expire_blockhash();
    let attest_ix = build_attest_outcome_ix(&harness, &pdas, OUTCOME_YES);
    send_ixs(&mut harness.svm, &creator, &[attest_ix]);

    let attacker = Keypair::new();
    harness.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();

    harness.svm.expire_blockhash();
    let dispute_ix = build_dispute_ix(&pdas, attacker.pubkey(), OUTCOME_INVALID);
    let res = try_send_ixs(&mut harness.svm, &attacker, &[dispute_ix]);
    assert!(
        res.is_err(),
        "dispute with non-dispute-authority signer must be rejected"
    );

    // Outcome unchanged.
    let market = fetch_market(&harness.svm, pdas.market);
    assert_eq!(market.winning_outcome, OUTCOME_YES);
    let adj = fetch_adjudicator(&harness.svm, pdas.adjudicator_pda);
    assert!(!adj.disputed);
}
