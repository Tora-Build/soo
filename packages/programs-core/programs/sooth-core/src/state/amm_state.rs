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
        + 1; // bump
}

/// Cross-crate layout sync: `AmmState::SPACE` must match `POSITION_TOTAL_LEN`
/// in `constants.rs`. Actually this assert ties AmmState offset
/// constants. We just assert Position size hasn't drifted.
const _: () = assert!(POSITION_TOTAL_LEN == 121);
