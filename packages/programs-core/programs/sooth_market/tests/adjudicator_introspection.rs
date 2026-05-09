//! Host-side tests for the parent-ix introspection gate used by
//! `lock_for_resolution` and `settle` against the `sooth_adjudicator`
//! program. Companion to `transfer_helpers.rs` — same shape, different
//! parent program.
//!
//! ## What's covered
//!
//! 1. Discriminator constants match Anchor's `sha256("global:<ix>")[..8]`
//!    for `request_lock` and `attest_outcome`.
//! 2. Accepts when the legitimate `sooth_adjudicator::request_lock` /
//!    `attest_outcome` parent is at the current top-level slot.
//! 3. Rejects direct calls to `lock_for_resolution` / `settle` (no
//!    sooth_adjudicator parent in prefix) — closes the deferred half of
//!    Codex's C2 finding.
//! 4. Rejects when an unrelated program (or `sooth_amm`) is the parent.
//! 5. Rejects cross-discriminator: a `request_lock` parent must not
//!    satisfy the `settle` (attest_outcome) gate.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::sysvar::instructions::{
    construct_instructions_data, store_current_index, BorrowedAccountMeta, BorrowedInstruction,
};

use sooth_market::error::SoothMarketError;
use sooth_market::instruction_introspection::{
    require_parent_ix_from_data, ATTEST_OUTCOME_DISCRIMINATOR, REQUEST_LOCK_DISCRIMINATOR,
};
use sooth_market::SOOTH_ADJUDICATOR_PROGRAM_ID;

/// Sha256-of-`global:<ix>` reproduction. Mirrors anchor-syn's
/// `Discriminator` derive without the proc-macro round-trip.
fn anchor_disc(name: &str) -> [u8; 8] {
    use anchor_lang::solana_program::hash::hash;
    let preimage = format!("global:{name}");
    let h = hash(preimage.as_bytes()).to_bytes();
    let mut out = [0u8; 8];
    out.copy_from_slice(&h[..8]);
    out
}

#[test]
fn request_lock_discriminator_matches_anchor() {
    assert_eq!(REQUEST_LOCK_DISCRIMINATOR, anchor_disc("request_lock"));
}

#[test]
fn attest_outcome_discriminator_matches_anchor() {
    assert_eq!(ATTEST_OUTCOME_DISCRIMINATOR, anchor_disc("attest_outcome"));
}

#[track_caller]
fn assert_invalid_parent(res: Result<(), SoothMarketError>, ctx: &str) {
    match res {
        Err(SoothMarketError::InvalidParentInstruction) => {}
        other => panic!("{ctx}: expected InvalidParentInstruction, got {other:?}"),
    }
}

fn build_sysvar_data(ixs: &[Instruction], current_index: u16) -> Vec<u8> {
    let borrowed: Vec<BorrowedInstruction> = ixs
        .iter()
        .map(|ix| BorrowedInstruction {
            program_id: &ix.program_id,
            accounts: ix
                .accounts
                .iter()
                .map(|m| BorrowedAccountMeta {
                    pubkey: &m.pubkey,
                    is_signer: m.is_signer,
                    is_writable: m.is_writable,
                })
                .collect(),
            data: &ix.data,
        })
        .collect();
    let mut data = construct_instructions_data(&borrowed);
    store_current_index(&mut data, current_index);
    data
}

fn make_ix(program_id: Pubkey, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id,
        accounts: vec![AccountMeta::new(Pubkey::new_unique(), true)],
        data,
    }
}

fn adj_id() -> Pubkey {
    SOOTH_ADJUDICATOR_PROGRAM_ID
}

#[test]
fn accepts_request_lock_parent() {
    // Legitimate adjudicator-driven lock: the only top-level ix is
    // `sooth_adjudicator::request_lock`, which CPIs into
    // `sooth_market::lock_for_resolution`. The CPI inherits the parent's
    // top-level slot, so current_index = 0 and the walk finds the parent
    // at index 0.
    let parent = make_ix(adj_id(), REQUEST_LOCK_DISCRIMINATOR.to_vec());
    let data = build_sysvar_data(&[parent], 0);
    let res = require_parent_ix_from_data(&data, &adj_id(), &REQUEST_LOCK_DISCRIMINATOR);
    assert!(
        res.is_ok(),
        "request_lock CPI must be accepted; got {res:?}"
    );
}

#[test]
fn accepts_attest_outcome_parent() {
    // Symmetric flow for `settle`: the parent ix is
    // `sooth_adjudicator::attest_outcome`.
    let parent = make_ix(adj_id(), ATTEST_OUTCOME_DISCRIMINATOR.to_vec());
    let data = build_sysvar_data(&[parent], 0);
    let res = require_parent_ix_from_data(&data, &adj_id(), &ATTEST_OUTCOME_DISCRIMINATOR);
    assert!(
        res.is_ok(),
        "attest_outcome CPI must be accepted; got {res:?}"
    );
}

#[test]
fn rejects_direct_lock_for_resolution_call() {
    // Attacker calls `lock_for_resolution` directly (no sooth_adjudicator
    // parent in the prefix). This is exactly the Codex C2 deferred attack
    // surface — must reject.
    let direct = make_ix(Pubkey::new_unique(), vec![0xFF]);
    let data = build_sysvar_data(&[direct], 0);
    let res = require_parent_ix_from_data(&data, &adj_id(), &REQUEST_LOCK_DISCRIMINATOR);
    assert_invalid_parent(res, "direct lock_for_resolution call must be rejected");
}

#[test]
fn rejects_direct_settle_call() {
    let direct = make_ix(Pubkey::new_unique(), vec![0xFF]);
    let data = build_sysvar_data(&[direct], 0);
    let res = require_parent_ix_from_data(&data, &adj_id(), &ATTEST_OUTCOME_DISCRIMINATOR);
    assert_invalid_parent(res, "direct settle call must be rejected");
}

#[test]
fn rejects_unrelated_program_with_matching_discriminator() {
    // An attacker stitches together an ix from an unrelated program whose
    // first 8 bytes happen to equal `attest_outcome`. The program-id check
    // must prevent the gate from passing.
    let attacker = make_ix(Pubkey::new_unique(), ATTEST_OUTCOME_DISCRIMINATOR.to_vec());
    let data = build_sysvar_data(&[attacker], 0);
    let res = require_parent_ix_from_data(&data, &adj_id(), &ATTEST_OUTCOME_DISCRIMINATOR);
    assert_invalid_parent(
        res,
        "non-adjudicator program must be rejected even with matching discriminator",
    );
}

#[test]
fn rejects_request_lock_satisfying_settle_gate() {
    // Cross-discriminator hardening: a `request_lock` parent must NOT
    // satisfy the `settle` (attest_outcome) gate. If it could, an
    // adjudicator that legitimately holds a `request_lock` ix could
    // illegitimately drive a settle in the same tx.
    let parent = make_ix(adj_id(), REQUEST_LOCK_DISCRIMINATOR.to_vec());
    let data = build_sysvar_data(&[parent], 0);
    let res = require_parent_ix_from_data(&data, &adj_id(), &ATTEST_OUTCOME_DISCRIMINATOR);
    assert_invalid_parent(res, "request_lock parent must not satisfy settle gate");
}

#[test]
fn rejects_attest_outcome_satisfying_lock_gate() {
    let parent = make_ix(adj_id(), ATTEST_OUTCOME_DISCRIMINATOR.to_vec());
    let data = build_sysvar_data(&[parent], 0);
    let res = require_parent_ix_from_data(&data, &adj_id(), &REQUEST_LOCK_DISCRIMINATOR);
    assert_invalid_parent(res, "attest_outcome parent must not satisfy lock gate");
}
