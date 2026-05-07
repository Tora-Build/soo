//! Runtime CPI integration test: `sooth_adjudicator::attest_outcome` →
//! `sooth_market::settle`.
//!
//! Companion to `cpi_lock_for_resolution.rs`. Closes the runtime gap left
//! by `tests/adjudicator_introspection.rs`'s host-side parser tests by
//! actually loading the four `.so` binaries and dispatching the cross-
//! program settle flow on a live SBF VM.
//!
//! Coverage:
//!   1. Each Outcome variant (NO=0, YES=1, INVALID=2) flips the market
//!      from `Locked` to `Settled` via the adjudicator program's CPI into
//!      `sooth_market::settle`. The on-market `winning_outcome` field
//!      mirrors the value passed at the adjudicator-side ix.
//!   2. Idempotency — `attest_outcome` is single-shot per market. The
//!      adjudicator-side `AlreadyAttested` guard rejects a second call
//!      and the market remains `Settled` with the first-attestation
//!      outcome.

mod common;

use common::*;
use sooth_market::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use sooth_market::state::MarketLifecycle;

/// Run the full Open → Locked → Settled flow under a single Harness, with
/// `winning_outcome` chosen by the caller. Returns the final Market state
/// for the caller to assert on.
fn run_settle_with_outcome(salt: u8, winning_outcome: u8) -> sooth_market::state::Market {
    let mut harness = Harness::boot();
    let pdas = bootstrap_market(&mut harness, market_id(salt));
    register_adjudicator(&mut harness, &pdas);

    // 1. Open → Locked.
    let creator = clone_keypair(&harness.creator);
    let lock_ix = build_request_lock_ix(&harness, &pdas);
    send_ixs(&mut harness.svm, &creator, &[lock_ix]);

    // 2. Locked → Settled with the chosen outcome.
    harness.svm.expire_blockhash();
    let attest_ix = build_attest_outcome_ix(&harness, &pdas, winning_outcome);
    send_ixs(&mut harness.svm, &creator, &[attest_ix]);

    fetch_market(&harness.svm, pdas.market)
}

#[test]
fn attest_outcome_yes_settles_market_with_yes() {
    let market = run_settle_with_outcome(0xB1, OUTCOME_YES);
    assert!(matches!(market.lifecycle, MarketLifecycle::Settled));
    assert_eq!(market.winning_outcome, OUTCOME_YES);
}

#[test]
fn attest_outcome_no_settles_market_with_no() {
    let market = run_settle_with_outcome(0xB2, OUTCOME_NO);
    assert!(matches!(market.lifecycle, MarketLifecycle::Settled));
    assert_eq!(market.winning_outcome, OUTCOME_NO);
}

#[test]
fn attest_outcome_invalid_settles_market_with_invalid() {
    // OUTCOME_INVALID = 2 is a valid resolution per the protocol-wide
    // encoding (mirrors EVM `TruthMarket.invalidate` semantics). The
    // settle handler accepts all three outcome variants.
    let market = run_settle_with_outcome(0xB3, OUTCOME_INVALID);
    assert!(matches!(market.lifecycle, MarketLifecycle::Settled));
    assert_eq!(market.winning_outcome, OUTCOME_INVALID);
}

#[test]
fn attest_outcome_is_single_shot_per_market() {
    // Idempotency: once `attest_outcome` lands and the market is `Settled`,
    // a second call must fail. The adjudicator-side handler trips
    // `AlreadyAttested` (the per-market `Adjudicator` PDA's
    // `attested_outcome` is now Some), so the second tx's CPI into
    // `settle` never actually runs.
    let mut harness = Harness::boot();
    let pdas = bootstrap_market(&mut harness, market_id(0xB4));
    register_adjudicator(&mut harness, &pdas);

    let creator = clone_keypair(&harness.creator);
    let lock_ix = build_request_lock_ix(&harness, &pdas);
    send_ixs(&mut harness.svm, &creator, &[lock_ix]);

    harness.svm.expire_blockhash();
    let first_attest = build_attest_outcome_ix(&harness, &pdas, OUTCOME_YES);
    send_ixs(&mut harness.svm, &creator, &[first_attest]);

    // Second attest — must fail. We assert on the broad shape (any tx
    // failure) rather than the exact custom code so this test stays
    // robust to error-code reshuffling.
    harness.svm.expire_blockhash();
    let second_attest = build_attest_outcome_ix(&harness, &pdas, OUTCOME_NO);
    let res = try_send_ixs(&mut harness.svm, &creator, &[second_attest]);
    assert!(
        res.is_err(),
        "second attest_outcome must be rejected; got Ok"
    );

    // Outcome must be the first-attestation value.
    let market = fetch_market(&harness.svm, pdas.market);
    assert!(matches!(market.lifecycle, MarketLifecycle::Settled));
    assert_eq!(market.winning_outcome, OUTCOME_YES);
}

#[test]
fn attest_outcome_writes_adjudicator_state() {
    // Belt-and-braces: in addition to the on-market `winning_outcome`
    // mirror, the per-market `Adjudicator` PDA's `attested_outcome` is
    // populated. Indexers depend on both fields.
    let mut harness = Harness::boot();
    let pdas = bootstrap_market(&mut harness, market_id(0xB5));
    register_adjudicator(&mut harness, &pdas);

    let creator = clone_keypair(&harness.creator);
    let lock_ix = build_request_lock_ix(&harness, &pdas);
    send_ixs(&mut harness.svm, &creator, &[lock_ix]);

    harness.svm.expire_blockhash();
    let attest_ix = build_attest_outcome_ix(&harness, &pdas, OUTCOME_YES);
    send_ixs(&mut harness.svm, &creator, &[attest_ix]);

    let adj = fetch_adjudicator(&harness.svm, pdas.adjudicator_pda);
    assert_eq!(adj.attested_outcome, Some(OUTCOME_YES));
    assert!(
        adj.attested_at.is_some(),
        "attested_at should be populated"
    );
}
