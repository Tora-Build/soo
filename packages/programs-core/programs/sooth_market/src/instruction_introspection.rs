//! Parent-instruction introspection used by `transfer_to_lock` and
//! `transfer_from_lock_vault` to enforce that callers route through the
//! legitimate `sooth_amm` dispatch rather than invoking the helpers directly.
//!
//! ## Why this exists
//!
//! Both helper ixs PDA-sign for `sooth_market`-owned authorities (`vault`
//! and `lock` signer PDAs). The user's outer signature still gates USDC
//! custody, so a direct call cannot exfiltrate funds — but it CAN move
//! `vault → lock_vault` without producing a matching `LockEntry` /
//! `Position` mutation, breaking AMM solvency. The same applies in reverse
//! for `transfer_from_lock_vault`. See the auth-gap session report for the
//! invariant statement.
//!
//! ## Mechanism
//!
//! Solana's `instructions` sysvar
//! (`Sysvar1nstructions1111111111111111111111111`) exposes the full top-level
//! instruction list of the current transaction. We require that one of the
//! ixs preceding the current CPI is the matching `sooth_amm` dispatch
//! (`sell_positions` for `transfer_to_lock`; `claim_unlocked` for
//! `transfer_from_lock_vault`). We match the program id + the first 8 bytes
//! of instruction data (Anchor's discriminator).
//!
//! ## Discriminators
//!
//! Discriminators are hardcoded as 8-byte arrays. They are
//! `sha256("global:<ix_name>")[..8]`. The canonical bytes now live in the
//! workspace-shared `sooth_protocol_types::discriminators` module (sister
//! to the byte-offset constants in `sooth-account-offsets`); we re-export
//! the four consumed by this module's gates at the same names so existing
//! call sites in `instructions/{settle,lock_for_resolution,transfer_*}`
//! and the test crates keep resolving without a churn-pass.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;

use crate::error::SoothMarketError;
use crate::{SOOTH_ADJUDICATOR_PROGRAM_ID, SOOTH_AMM_PROGRAM_ID};

// The five discriminators consumed by the gates below. See
// `sooth_protocol_types::discriminators` for the canonical definitions and
// the host-side test in `tests/{transfer_helpers,adjudicator_introspection}.rs`
// for the `sha256("global:<ix>")[..8]` re-derivation that pins these values
// against any drift in the on-chain Anchor codegen.
pub use sooth_protocol_types::{
    ATTEST_OUTCOME_DISCRIMINATOR, CLAIM_UNLOCKED_DISCRIMINATOR, DISPUTE_DISCRIMINATOR,
    REQUEST_LOCK_DISCRIMINATOR, SELL_POSITIONS_DISCRIMINATOR,
};

/// On-chain wrapper. Borrows the sysvar account, scans the top-level ix
/// list up to and including the current index, and accepts iff one of those
/// slots is from `sooth_amm` with the expected discriminator. Errors
/// otherwise.
///
/// ## Why `0..=current_index`
///
/// `load_current_index_checked` returns the index of the **currently
/// executing top-level ix** — CPIs inherit their parent's slot, they don't
/// get their own entry. So when `sooth_amm::sell_positions` (top-level
/// index N) CPIs into `sooth_market::transfer_to_lock`, the runtime
/// reports `current_index = N` from inside the CPI. The parent dispatcher
/// is therefore at position N (the current index), not strictly before it.
///
/// We additionally scan everything strictly before the current index so
/// the gate tolerates tx-layout variations where the legitimate dispatcher
/// is preceded by ComputeBudgetProgram budget ixs or ATA-create ixs. Slots
/// AFTER `current_index` are excluded — they haven't executed yet, so a
/// future ix in the same tx must not satisfy the gate (it would otherwise
/// allow a malicious tx to "cite" a sell_positions ix that never runs).
pub fn require_parent_ix(
    instruction_sysvar: &AccountInfo,
    expected_discriminator: &[u8; 8],
) -> Result<()> {
    require_parent_ix_from_program(
        instruction_sysvar,
        &SOOTH_AMM_PROGRAM_ID,
        expected_discriminator,
    )
}

/// Generalized variant of `require_parent_ix` that accepts an arbitrary
/// expected program id. Used by `lock_for_resolution` / `settle` (which
/// require `sooth_adjudicator::ID`) and indirectly by `transfer_to_lock`
/// / `transfer_from_lock_vault` (which keep the AMM-pinned shorthand
/// above for backwards compatibility).
///
/// The scan window (`0..=current_index`) and the parent-ix matching
/// invariant are identical to the single-program version — see the
/// docstring on `require_parent_ix` above for the full rationale.
pub fn require_parent_ix_from_program(
    instruction_sysvar: &AccountInfo,
    expected_program: &Pubkey,
    expected_discriminator: &[u8; 8],
) -> Result<()> {
    let current_index = ix_sysvar::load_current_index_checked(instruction_sysvar)? as usize;

    for i in 0..=current_index {
        let ix = ix_sysvar::load_instruction_at_checked(i, instruction_sysvar)?;
        if ix.program_id == *expected_program
            && ix.data.len() >= 8
            && &ix.data[..8] == expected_discriminator
        {
            return Ok(());
        }
    }

    Err(error!(SoothMarketError::InvalidParentInstruction))
}

/// Convenience wrapper specialised to `sooth_adjudicator::ID`. Used by
/// `lock_for_resolution` (REQUEST_LOCK_DISCRIMINATOR) and `settle`
/// (ATTEST_OUTCOME_DISCRIMINATOR). The dedicated wrapper keeps call sites
/// readable — `require_adjudicator_parent_ix(sysvar, &DISCRIMINATOR)`.
pub fn require_adjudicator_parent_ix(
    instruction_sysvar: &AccountInfo,
    expected_discriminator: &[u8; 8],
) -> Result<()> {
    require_parent_ix_from_program(
        instruction_sysvar,
        &SOOTH_ADJUDICATOR_PROGRAM_ID,
        expected_discriminator,
    )
}

/// Accept-any-of variant of `require_adjudicator_parent_ix`. Used by
/// `settle` to allow either `attest_outcome` (the happy path) or `dispute`
/// (the veto-override path) as a legitimate parent. The semantics are
/// otherwise identical to the single-discriminator wrapper: the caller must
/// be `sooth_adjudicator::ID` and the matched ix must lie in the
/// `0..=current_index` window. Rejects with `InvalidParentInstruction` if
/// none of the supplied discriminators match.
pub fn require_adjudicator_parent_ix_any(
    instruction_sysvar: &AccountInfo,
    expected_discriminators: &[[u8; 8]],
) -> Result<()> {
    let current_index = ix_sysvar::load_current_index_checked(instruction_sysvar)? as usize;

    for i in 0..=current_index {
        let ix = ix_sysvar::load_instruction_at_checked(i, instruction_sysvar)?;
        if ix.program_id != SOOTH_ADJUDICATOR_PROGRAM_ID {
            continue;
        }
        if ix.data.len() < 8 {
            continue;
        }
        let head = &ix.data[..8];
        for expected in expected_discriminators {
            if head == expected {
                return Ok(());
            }
        }
    }

    Err(error!(SoothMarketError::InvalidParentInstruction))
}

/// Pure host-side parser that operates directly on the serialized sysvar
/// data. Mirrors `require_parent_ix` but without the `AccountInfo` shell so
/// it can be exercised by `cargo test -p sooth_market` (which doesn't ship
/// a BanksClient harness — see `tests/lock_flow.rs` in `sooth_amm` for
/// rationale on why on-chain ix tests live in the TS integration suite).
///
/// The on-chain wrapper above delegates to `load_instruction_at_checked`
/// which internally calls `deserialize_instruction` on the same byte
/// layout, so the predicate logic is identical.
#[allow(deprecated)]
pub fn require_parent_ix_from_data(
    sysvar_data: &[u8],
    expected_program: &Pubkey,
    expected_discriminator: &[u8; 8],
) -> std::result::Result<(), SoothMarketError> {
    if sysvar_data.len() < 2 {
        return Err(SoothMarketError::InvalidParentInstruction);
    }
    let len = sysvar_data.len();
    let mut idx_buf = [0u8; 2];
    idx_buf.copy_from_slice(&sysvar_data[len - 2..len]);
    let current_index = u16::from_le_bytes(idx_buf) as usize;

    for i in 0..=current_index {
        let ix = match ix_sysvar::load_instruction_at(i, sysvar_data) {
            Ok(ix) => ix,
            Err(_) => return Err(SoothMarketError::InvalidParentInstruction),
        };
        if ix.program_id == *expected_program
            && ix.data.len() >= 8
            && &ix.data[..8] == expected_discriminator
        {
            return Ok(());
        }
    }

    Err(SoothMarketError::InvalidParentInstruction)
}

/// Multi-discriminator host-side parser variant. Mirrors
/// `require_adjudicator_parent_ix_any` for the host-side tests in
/// `tests/adjudicator_introspection.rs` so the parent-ix gate's "either
/// `attest_outcome` or `dispute`" semantics are exercised without the SBF
/// VM. Sister to `require_parent_ix_from_data`; same byte-layout trick.
#[allow(deprecated)]
pub fn require_parent_ix_from_data_any(
    sysvar_data: &[u8],
    expected_program: &Pubkey,
    expected_discriminators: &[[u8; 8]],
) -> std::result::Result<(), SoothMarketError> {
    if sysvar_data.len() < 2 {
        return Err(SoothMarketError::InvalidParentInstruction);
    }
    let len = sysvar_data.len();
    let mut idx_buf = [0u8; 2];
    idx_buf.copy_from_slice(&sysvar_data[len - 2..len]);
    let current_index = u16::from_le_bytes(idx_buf) as usize;

    for i in 0..=current_index {
        let ix = match ix_sysvar::load_instruction_at(i, sysvar_data) {
            Ok(ix) => ix,
            Err(_) => return Err(SoothMarketError::InvalidParentInstruction),
        };
        if ix.program_id != *expected_program {
            continue;
        }
        if ix.data.len() < 8 {
            continue;
        }
        let head = &ix.data[..8];
        for expected in expected_discriminators {
            if head == expected {
                return Ok(());
            }
        }
    }

    Err(SoothMarketError::InvalidParentInstruction)
}
