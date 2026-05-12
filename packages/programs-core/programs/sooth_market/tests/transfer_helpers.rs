//! Host-side tests for the parent-ix introspection gate used by
//! `transfer_to_lock` and `transfer_from_lock_vault`.
//!
//! ## What's covered
//!
//! 1. Discriminator constants match Anchor's `sha256("global:<ix>")[..8]`.
//! 2. `require_parent_ix_from_data` accepts when the sysvar data shows a
//!    sooth_amm dispatch at the current top-level slot — i.e. the
//!    legitimate CPI shape (CPI children inherit their parent's slot).
//! 3. Rejects direct call (no sooth_amm dispatch in the prefix or at
//!    current_index) — closes the auth gap.
//! 4. Rejects when an unrelated program is the parent.
//! 5. Rejects when sooth_amm appears as the parent but with the wrong
//!    discriminator.
//! 6. Rejects when the matching ix is strictly AFTER the current index
//!    (the runtime executes top-level ixs in order; a future ix can't
//!    legitimise a past CPI).
//! 7. Cross-helper hardening: `claim_unlocked` parent must not satisfy a
//!    `transfer_to_lock` gate (and vice versa).
//! 8. Short-data ixs (data.len() < 8) are rejected without panicking.
//!
//! ## Test framework
//!
//! Pure host-side, no BanksClient. We synthesize the sysvar data with the
//! same `serialize_instructions` shape Solana's runtime uses (the helper
//! is gated behind `not(target_os = "solana")` and is freely callable in
//! tests). The on-chain `require_parent_ix` wrapper delegates to the same
//! parser under the hood; if the pure version is correct so is the wrapper.
//!
//! See `programs/sooth_amm/tests/lock_flow.rs` for the rationale on why
//! full BanksClient ix tests live in the SDK-side TS suite, not here.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::sysvar::instructions::{
    construct_instructions_data, store_current_index, BorrowedAccountMeta, BorrowedInstruction,
};

use sooth_market::error::SoothMarketError;
use sooth_market::instruction_introspection::{
    require_parent_ix_from_data, CLAIM_UNLOCKED_DISCRIMINATOR, SELL_POSITIONS_DISCRIMINATOR,
};
use sooth_market::SOOTH_AMM_PROGRAM_ID;
use sooth_protocol_types::TRANSFER_FEE_TO_MARKET_POOL_DISCRIMINATOR;

/// `SoothMarketError` doesn't derive `PartialEq` (Anchor's `#[error_code]`
/// macro doesn't add it), so `assert_eq!(res, Err(...))` won't compile. We
/// pattern-match against the variant instead.
#[track_caller]
fn assert_invalid_parent(res: Result<(), SoothMarketError>, ctx: &str) {
    match res {
        Err(SoothMarketError::InvalidParentInstruction) => {}
        other => panic!("{ctx}: expected InvalidParentInstruction, got {other:?}"),
    }
}

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
fn sell_positions_discriminator_matches_anchor() {
    assert_eq!(SELL_POSITIONS_DISCRIMINATOR, anchor_disc("sell_positions"));
}

#[test]
fn claim_unlocked_discriminator_matches_anchor() {
    assert_eq!(CLAIM_UNLOCKED_DISCRIMINATOR, anchor_disc("claim_unlocked"));
}

#[test]
fn transfer_fee_to_market_pool_discriminator_matches_anchor() {
    assert_eq!(
        TRANSFER_FEE_TO_MARKET_POOL_DISCRIMINATOR,
        anchor_disc("transfer_fee_to_market_pool")
    );
}

/// Build a fake sysvar blob containing the given ixs, with the given
/// `current_index`. Uses the same `construct_instructions_data` the runtime
/// uses, so the bytes round-trip through `load_instruction_at`.
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

fn sooth_amm_id() -> Pubkey {
    SOOTH_AMM_PROGRAM_ID
}

#[test]
fn accepts_sell_positions_at_current_index() {
    // Most realistic legitimate flow: ComputeBudgetProgram set-units at
    // index 0, sooth_amm::sell_positions at index 1. The CPI to
    // transfer_to_lock runs WITHIN sell_positions's execution, so the
    // sysvar reports current_index = 1 (the slot of the active top-level
    // ix). The walk `0..=current_index` finds the dispatcher at index 1.
    let cb = make_ix(Pubkey::new_unique(), vec![0xCB]);
    let parent = make_ix(sooth_amm_id(), SELL_POSITIONS_DISCRIMINATOR.to_vec());
    let data = build_sysvar_data(&[cb, parent], 1);
    let res = require_parent_ix_from_data(&data, &sooth_amm_id(), &SELL_POSITIONS_DISCRIMINATOR);
    assert!(
        res.is_ok(),
        "legitimate CPI from sooth_amm::sell_positions must be accepted; got {res:?}"
    );
}

#[test]
fn accepts_claim_unlocked_at_current_index() {
    // Symmetric flow for transfer_from_lock_vault.
    let cb = make_ix(Pubkey::new_unique(), vec![0xCB]);
    let parent = make_ix(sooth_amm_id(), CLAIM_UNLOCKED_DISCRIMINATOR.to_vec());
    let data = build_sysvar_data(&[cb, parent], 1);
    let res = require_parent_ix_from_data(&data, &sooth_amm_id(), &CLAIM_UNLOCKED_DISCRIMINATOR);
    assert!(
        res.is_ok(),
        "legitimate CPI from sooth_amm::claim_unlocked must be accepted; got {res:?}"
    );
}

#[test]
fn accepts_when_dispatch_is_at_index_zero() {
    // Even simpler legit shape: the only ix is sell_positions at index 0,
    // current_index = 0. The CPI inherits index 0. The walk `0..=0` covers
    // it. This is the typical demo / SDK shape today (no compute-budget
    // wrapper).
    let parent = make_ix(sooth_amm_id(), SELL_POSITIONS_DISCRIMINATOR.to_vec());
    let data = build_sysvar_data(&[parent], 0);
    let res = require_parent_ix_from_data(&data, &sooth_amm_id(), &SELL_POSITIONS_DISCRIMINATOR);
    assert!(
        res.is_ok(),
        "single-ix legit CPI must be accepted; got {res:?}"
    );
}

#[test]
fn rejects_direct_call_no_sooth_amm_in_prefix() {
    // Attacker calls transfer_to_lock directly (helper invoked as the sole
    // top-level ix from a different program / signer). current_index = 0,
    // and the only ix is some unrelated program (or sooth_market itself
    // re-invoked). Must reject.
    let helper_marker = make_ix(Pubkey::new_unique(), vec![0xFF]);
    let data = build_sysvar_data(&[helper_marker], 0);
    let res = require_parent_ix_from_data(&data, &sooth_amm_id(), &SELL_POSITIONS_DISCRIMINATOR);
    assert_invalid_parent(res, "direct call (no sooth_amm parent) must be rejected");
}

#[test]
fn rejects_unrelated_program_as_parent() {
    // The parent slot's program_id is not sooth_amm, even though its data
    // happens to start with the sell_positions discriminator. Must reject:
    // discriminators alone are not unique across programs (Anchor's
    // namespacing is `program_id + discriminator`).
    let unrelated = make_ix(Pubkey::new_unique(), SELL_POSITIONS_DISCRIMINATOR.to_vec());
    let data = build_sysvar_data(&[unrelated], 0);
    let res = require_parent_ix_from_data(&data, &sooth_amm_id(), &SELL_POSITIONS_DISCRIMINATOR);
    assert_invalid_parent(res, "non-sooth_amm parent program must be rejected");
}

#[test]
fn rejects_wrong_discriminator() {
    // sooth_amm parent ix but with a non-sell_positions discriminator. A
    // future sooth_amm read-only ix or a `trade_positions` (buy) ix must
    // not satisfy the gate for the sell-side helper.
    let wrong_disc = [0xAA; 8].to_vec();
    let outer = make_ix(sooth_amm_id(), wrong_disc);
    let data = build_sysvar_data(&[outer], 0);
    let res = require_parent_ix_from_data(&data, &sooth_amm_id(), &SELL_POSITIONS_DISCRIMINATOR);
    assert_invalid_parent(
        res,
        "sooth_amm parent with wrong discriminator must be rejected",
    );
}

#[test]
fn rejects_claim_when_only_sell_parent() {
    // Cross-helper hardening: a `transfer_from_lock_vault` call must not
    // succeed when the parent is `sell_positions`, and vice versa.
    let parent = make_ix(sooth_amm_id(), SELL_POSITIONS_DISCRIMINATOR.to_vec());
    let data = build_sysvar_data(&[parent], 0);
    let res = require_parent_ix_from_data(&data, &sooth_amm_id(), &CLAIM_UNLOCKED_DISCRIMINATOR);
    assert_invalid_parent(
        res,
        "transfer_from_lock_vault gate must reject sell_positions parent",
    );
}

#[test]
fn rejects_sell_when_only_claim_parent() {
    let parent = make_ix(sooth_amm_id(), CLAIM_UNLOCKED_DISCRIMINATOR.to_vec());
    let data = build_sysvar_data(&[parent], 0);
    let res = require_parent_ix_from_data(&data, &sooth_amm_id(), &SELL_POSITIONS_DISCRIMINATOR);
    assert_invalid_parent(
        res,
        "transfer_to_lock gate must reject claim_unlocked parent",
    );
}

#[test]
fn rejects_short_data_ix() {
    // A sooth_amm ix carrying < 8 bytes of data can't carry a
    // discriminator. Must reject (and not panic on slice-out-of-bounds).
    let short = make_ix(sooth_amm_id(), vec![0x01, 0x02, 0x03]);
    let data = build_sysvar_data(&[short], 0);
    let res = require_parent_ix_from_data(&data, &sooth_amm_id(), &SELL_POSITIONS_DISCRIMINATOR);
    assert_invalid_parent(res, "short-data sooth_amm ix must be rejected, not panic");
}

#[test]
fn rejects_when_match_is_after_current_index() {
    // The matching parent is at index 2 but current_index is 1. The walk
    // is bounded by current_index (inclusive), so index 2 is out of
    // scope. Must reject.
    //
    // This guards against a subtle attack: a malicious tx that lists the
    // helper at index 1 and ALSO lists a sell_positions ix at index 2
    // (which would never actually run before the helper). The runtime's
    // strict ordering means index 2 hasn't executed yet when index 1
    // runs, so it must not satisfy the gate.
    let unrelated = make_ix(Pubkey::new_unique(), vec![0xFF]);
    let helper_pos = make_ix(Pubkey::new_unique(), vec![0xEE]);
    let later = make_ix(sooth_amm_id(), SELL_POSITIONS_DISCRIMINATOR.to_vec());
    let data = build_sysvar_data(&[unrelated, helper_pos, later], 1);
    let res = require_parent_ix_from_data(&data, &sooth_amm_id(), &SELL_POSITIONS_DISCRIMINATOR);
    assert_invalid_parent(
        res,
        "ix at index > current_index must not satisfy the parent gate",
    );
}
