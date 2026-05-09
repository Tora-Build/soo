//! Runtime CPI integration test: direct calls to
//! `sooth_market::lock_for_resolution` and `sooth_market::settle` MUST be
//! rejected.
//!
//! This closes the runtime half of Codex's C2 finding (the host-side parser
//! side is covered by `tests/adjudicator_introspection.rs`). The on-chain
//! `instruction_introspection::require_adjudicator_parent_ix` gate refuses
//! to authorise the lifecycle mutation when the top-level ix is not
//! `sooth_adjudicator::request_lock` / `attest_outcome` from the canonical
//! adjudicator program id.
//!
//! Without this gate, a market.creator who slipped past the
//! `AdjudicatorAllowlist` create-time check (or who acquired the allowlist
//! authority) could simply submit `lock_for_resolution` / `settle`
//! themselves and bypass the per-market `Adjudicator` PDA. This test pins
//! that the gate refuses the direct call at runtime — not just in the
//! unit-test parser mock.

mod common;

use anchor_lang::solana_program::sysvar;
use anchor_lang::{InstructionData, ToAccountMetas};
use common::*;
use solana_sdk::instruction::Instruction;

#[test]
fn direct_lock_for_resolution_call_is_rejected() {
    let mut harness = Harness::boot();
    let pdas = bootstrap_market(&mut harness, market_id(0xC1));
    register_adjudicator(&mut harness, &pdas);

    // Build a `lock_for_resolution` ix targeting `sooth_market` directly —
    // exactly the attack surface the introspection gate must close. The
    // `adjudicator_pda` and `instruction_sysvar` accounts are provided
    // (so account-resolution succeeds and the handler actually runs); the
    // gate then rejects because the parent ix is `lock_for_resolution`
    // itself, not `sooth_adjudicator::request_lock`.
    let accounts = sooth_market::accounts::LockForResolution {
        market: pdas.market,
        adjudicator_pda: pdas.adjudicator_pda,
        instruction_sysvar: sysvar::instructions::ID,
    };
    let ix = Instruction {
        program_id: MARKET_ID,
        accounts: accounts.to_account_metas(None),
        data: sooth_market::instruction::LockForResolution {}.data(),
    };

    let creator = clone_keypair(&harness.creator);
    let res = try_send_ixs(&mut harness.svm, &creator, &[ix]);
    assert!(
        res.is_err(),
        "direct lock_for_resolution call must be rejected by the parent-ix introspection gate"
    );

    // Lifecycle remains Open — the gate must short-circuit before the
    // lifecycle mutation.
    let market = fetch_market(&harness.svm, pdas.market);
    assert!(
        matches!(market.lifecycle, sooth_market::state::MarketLifecycle::Open),
        "lifecycle must stay Open after direct call rejection, got {:?}",
        market.lifecycle
    );
}

#[test]
fn direct_settle_call_is_rejected() {
    let mut harness = Harness::boot();
    let pdas = bootstrap_market(&mut harness, market_id(0xC2));
    register_adjudicator(&mut harness, &pdas);

    // Drive the market to `Locked` via the legitimate path first so the
    // direct-`settle` rejection isn't masked by the lifecycle gate (which
    // would reject any `Open → Settled` transition outright).
    let creator = clone_keypair(&harness.creator);
    let lock_ix = build_request_lock_ix(&harness, &pdas);
    send_ixs(&mut harness.svm, &creator, &[lock_ix]);

    // Now attempt a direct `settle` call with a valid outcome. The
    // introspection gate must reject because the parent ix is `settle`
    // itself, not `sooth_adjudicator::attest_outcome`.
    let accounts = sooth_market::accounts::Settle {
        market: pdas.market,
        adjudicator_pda: pdas.adjudicator_pda,
        instruction_sysvar: sysvar::instructions::ID,
    };
    let ix = Instruction {
        program_id: MARKET_ID,
        accounts: accounts.to_account_metas(None),
        data: sooth_market::instruction::Settle {
            winning_outcome: sooth_market::state::market::OUTCOME_YES,
        }
        .data(),
    };

    harness.svm.expire_blockhash();
    let res = try_send_ixs(&mut harness.svm, &creator, &[ix]);
    assert!(
        res.is_err(),
        "direct settle call must be rejected by the parent-ix introspection gate"
    );

    // Lifecycle remains Locked — the gate must short-circuit before the
    // lifecycle mutation. winning_outcome must NOT have been written.
    let market = fetch_market(&harness.svm, pdas.market);
    assert!(
        matches!(
            market.lifecycle,
            sooth_market::state::MarketLifecycle::Locked
        ),
        "lifecycle must stay Locked after direct call rejection, got {:?}",
        market.lifecycle
    );
}
