//! `Position` — per-(user, market) AMM position.
//!
//! Copied verbatim from `sooth_amm::state::Position`. Seeds and layout
//! are unchanged; the owning program is now `sooth_core`.

use anchor_lang::prelude::*;

use crate::constants::POSITION_TOTAL_LEN;

#[account]
pub struct Position {
    pub user: Pubkey,
    pub market: Pubkey,
    pub yes_shares: i128,
    pub no_shares: i128,
    /// Cumulative USDC cost paid by this position (used for refund on dismiss).
    pub locked_cost_usdc: u64,
    /// Per-position nonce used to derive unique `LockEntry` PDAs on each sell.
    pub lock_nonce: u64,
    pub bump: u8,
}

impl Position {
    /// Seeds: `[b"pos", market_id, user]` under `sooth_core::ID`.
    pub const SPACE: usize = 8     // discriminator
        + 32                       // user
        + 32                       // market
        + 16                       // yes_shares
        + 16                       // no_shares
        + 8                        // locked_cost_usdc
        + 8                        // lock_nonce
        + 1; // bump
}

/// Compile-time assert: Position::SPACE must match POSITION_TOTAL_LEN in
/// `constants.rs`.
const _: () = assert!(Position::SPACE == POSITION_TOTAL_LEN);
