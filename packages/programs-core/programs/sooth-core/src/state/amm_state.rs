//! `AmmState` — per-market LMSR AMM cursor.

use anchor_lang::prelude::*;

use crate::constants::POSITION_TOTAL_LEN;

#[account]
pub struct AmmState {
    /// Backlink to `Market` PDA.
    pub market: Pubkey,
    /// LMSR q_yes — shares outstanding on the YES side.
    pub q_yes: i128,
    /// LMSR q_no — shares outstanding on the NO side.
    pub q_no: i128,
    /// LMSR liquidity parameter `b` (positive i128, stored signed).
    pub b: i128,
    pub seed_q_yes: i128,
    pub seed_q_no: i128,
    /// Accumulated fee WAD for graduation threshold tracking.
    pub fee_b_base_wad: u128,
    /// Trial window end timestamp (architecture §9).
    pub trial_end_at: i64,
    pub is_graduated: bool,
    pub is_dismissed: bool,
    /// PDA bump.
    pub bump: u8,

    /// Forward-compat padding. Adding a field consumes bytes from here
    /// instead of changing the account's length, so no migration is needed:
    /// Solana accounts are fixed-length buffers, and an `#[account]` struct
    /// that outgrows its buffer fails to deserialize on every instruction
    /// that loads it. (Unlike EVM, where appending a storage slot is free.)
    ///
    /// When you add a field, shrink this by exactly its serialized size and
    /// leave `SPACE` unchanged.
    pub _reserved: [u8; 64],
}

impl AmmState {
    /// Seeds: `[b"amm", market_id]` under `sooth_core::ID`.
    pub const SPACE: usize = 8     // discriminator
        + 32                       // market
        + 16                       // q_yes
        + 16                       // q_no
        + 16                       // b
        + 16                       // seed_q_yes
        + 16                       // seed_q_no
        + 16                       // fee_b_base_wad
        + 8                        // trial_end_at
        + 1                        // is_graduated
        + 1                        // is_dismissed
        + 1                        // bump
        + 64; // _reserved
}

/// Layout sync guard: pins `POSITION_TOTAL_LEN` in `constants.rs` so the
/// `Position` layout cannot drift from the offsets used by raw parsers.
const _: () = assert!(POSITION_TOTAL_LEN == 153);

/// Fixture for the instruction-level guard tests: a live, ungraduated AMM
/// whose trial window has already closed.
#[cfg(test)]
pub(crate) fn amm_fixture() -> AmmState {
    AmmState {
        market: Pubkey::new_unique(),
        q_yes: 0,
        q_no: 0,
        b: 1,
        seed_q_yes: 0,
        seed_q_no: 0,
        fee_b_base_wad: 0,
        trial_end_at: 1_000,
        is_graduated: false,
        is_dismissed: false,
        bump: 255,
        _reserved: [0u8; 64],
    }
}
