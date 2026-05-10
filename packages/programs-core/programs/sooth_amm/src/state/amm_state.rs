//! `AmmState` account. Architecture §2.2 — the per-market AMM cursor.
//!
//! Holds the LMSR `q_yes`, `q_no`, `b` parameters plus seed/fee accumulators.
//! All quantities WAD-scaled (i128) to match the math module.

use anchor_lang::prelude::*;

#[account]
pub struct AmmState {
    /// Backlink to the market PDA (parity with EVM addressing).
    pub market: Pubkey,

    /// Outstanding YES shares in WAD. Signed because intermediate `q + Δ` can
    /// dip during multi-leg trades (see architecture §4.2).
    pub q_yes: i128,
    /// Outstanding NO shares in WAD.
    pub q_no: i128,

    /// LMSR liquidity parameter in WAD. > 0 by invariant.
    pub b: i128,

    /// Initial seed liquidity (creator deposit). Used by the dismiss/refund
    /// flow per architecture §9.
    pub seed_q_yes: i128,
    pub seed_q_no: i128,

    /// Accumulator for the bBase fee leg (50% pre-graduation per §8).
    /// In WAD; CPI'd out to the fee router after graduation.
    pub fee_b_base_wad: u128,

    pub trial_end_at: i64,
    pub is_graduated: bool,
    pub is_dismissed: bool,

    pub bump: u8,
}

impl AmmState {
    pub const SPACE: usize = 8   // discriminator
        + 32                     // market
        + 16 + 16                // q_yes, q_no
        + 16                     // b
        + 16 + 16                // seed_q_yes, seed_q_no
        + 16                     // fee_b_base_wad
        + 8                      // trial_end_at
        + 1                      // is_graduated
        + 1                      // is_dismissed
        + 1; // bump
}
