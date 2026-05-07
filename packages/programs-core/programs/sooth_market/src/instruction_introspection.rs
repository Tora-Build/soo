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
//! `sha256("global:<ix_name>")[..8]`, copied from
//! `packages/sdk-solana/src/anchor/sooth_amm.json` (which is hand-edited
//! from the on-chain Anchor codegen). The session brief permits hardcoding
//! because anchor-syn's `Discriminator` trait isn't reliable to derive at
//! compile time on this toolchain (Anchor 0.30.1 + cargo build-sbf).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;

use crate::error::SoothMarketError;
use crate::SOOTH_AMM_PROGRAM_ID;

/// Anchor discriminator for `sooth_amm::sell_positions`.
///   `sha256(b"global:sell_positions")[..8]`
/// Verified against `packages/sdk-solana/src/anchor/sooth_amm.json`'s
/// `instructions[].discriminator` for `sell_positions`.
pub const SELL_POSITIONS_DISCRIMINATOR: [u8; 8] = [3, 151, 9, 138, 95, 252, 50, 39];

/// Anchor discriminator for `sooth_amm::claim_unlocked`.
///   `sha256(b"global:claim_unlocked")[..8]`
/// Verified against `packages/sdk-solana/src/anchor/sooth_amm.json`'s
/// `instructions[].discriminator` for `claim_unlocked`.
pub const CLAIM_UNLOCKED_DISCRIMINATOR: [u8; 8] = [70, 139, 1, 246, 166, 193, 64, 143];

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
    let current_index = ix_sysvar::load_current_index_checked(instruction_sysvar)? as usize;

    for i in 0..=current_index {
        let ix = ix_sysvar::load_instruction_at_checked(i, instruction_sysvar)?;
        if ix.program_id == SOOTH_AMM_PROGRAM_ID
            && ix.data.len() >= 8
            && &ix.data[..8] == expected_discriminator
        {
            return Ok(());
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
