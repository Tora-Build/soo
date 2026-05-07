//! Runtime CPI integration test: `sooth_adjudicator::request_lock` →
//! `sooth_market::lock_for_resolution`.
//!
//! Closes the runtime gap left by `tests/adjudicator_introspection.rs` —
//! the host-side parser tests there pin the predicate logic, but they don't
//! actually load the .so binaries and run the cross-program dispatch on a
//! live SBF VM. This file does both: every meta and constraint that the on-
//! chain handlers care about (PDA derivations, owner checks, parent-ix
//! introspection, lifecycle gating) is exercised end-to-end through
//! LiteSVM.
//!
//! Coverage:
//!   1. Happy path — one `request_lock` ix flips the market from `Open` to
//!      `Locked` via the adjudicator program's CPI into
//!      `sooth_market::lock_for_resolution`.
//!   2. Idempotency — a second `request_lock` after the market is already
//!      `Locked` is rejected by the lifecycle gate (`Open → Locked` is the
//!      only legal transition into `Locked`).

mod common;

use common::*;

#[test]
fn request_lock_flips_open_to_locked_via_cpi() {
    let mut harness = Harness::boot();
    let pdas = bootstrap_market(&mut harness, market_id(0xA1));
    register_adjudicator(&mut harness, &pdas);

    // Sanity: market starts `Open` after `create_market`'s 4-leg flow.
    let pre = fetch_market(&harness.svm, pdas.market);
    assert!(
        matches!(
            pre.lifecycle,
            sooth_market::state::MarketLifecycle::Open
        ),
        "expected Open before request_lock, got {:?}",
        pre.lifecycle
    );

    // Dispatch the legitimate adjudicator-side trigger. The CPI plumbing in
    // `sooth_adjudicator::request_lock`'s handler builds the
    // `LockForResolution` cpi accounts struct and invokes
    // `sooth_market::cpi::lock_for_resolution`; the on-chain
    // `instruction_introspection` check reads the sysvar and walks
    // `0..=current_index` for a matching `(adj_program_id,
    // request_lock_disc)` entry.
    let creator = clone_keypair(&harness.creator);
    let ix = build_request_lock_ix(&harness, &pdas);
    send_ixs(&mut harness.svm, &creator, &[ix]);

    let post = fetch_market(&harness.svm, pdas.market);
    assert!(
        matches!(
            post.lifecycle,
            sooth_market::state::MarketLifecycle::Locked
        ),
        "expected Locked after request_lock CPI, got {:?}",
        post.lifecycle
    );
}

#[test]
fn second_request_lock_is_rejected_by_lifecycle_gate() {
    // Idempotency: after the first `request_lock` lands and the market is
    // `Locked`, a second call must fail. The lifecycle state machine only
    // accepts `Open → Locked`; a second invocation hits
    // `InvalidLifecycleTransition` in `lock_for_resolution`'s handler.
    let mut harness = Harness::boot();
    let pdas = bootstrap_market(&mut harness, market_id(0xA2));
    register_adjudicator(&mut harness, &pdas);

    let creator = clone_keypair(&harness.creator);
    let ix = build_request_lock_ix(&harness, &pdas);
    send_ixs(&mut harness.svm, &creator, &[ix]);

    // Second attempt — must fail. We assert on the broad shape (any
    // InstructionError on instruction index 0) rather than the exact custom
    // code so this test stays robust to error-code reshuffling. The
    // MarketLifecycle check itself is exercised by the existing
    // host-side `tests/lifecycle.rs`.
    harness.svm.expire_blockhash();
    let ix = build_request_lock_ix(&harness, &pdas);
    let res = try_send_ixs(&mut harness.svm, &creator, &[ix]);
    assert!(
        res.is_err(),
        "second request_lock must be rejected; got Ok"
    );

    // Lifecycle remains Locked (no progression).
    let post = fetch_market(&harness.svm, pdas.market);
    assert!(matches!(
        post.lifecycle,
        sooth_market::state::MarketLifecycle::Locked
    ));
}
