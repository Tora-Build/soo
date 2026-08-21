//! `Position` — per-(user, market) AMM position.

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

    /// Forward-compat padding. Adding a field consumes bytes from here
    /// instead of changing the account's length, so no migration is needed:
    /// Solana accounts are fixed-length buffers, and an `#[account]` struct
    /// that outgrows its buffer fails to deserialize on every instruction
    /// that loads it. (Unlike EVM, where appending a storage slot is free.)
    ///
    /// When you add a field, shrink this by exactly its serialized size and
    /// leave `SPACE` unchanged.
    pub _reserved: [u8; 32],
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
        + 1                        // bump
        + 32; // _reserved
}

/// Compile-time assert: Position::SPACE must match POSITION_TOTAL_LEN in
/// `constants.rs`.
const _: () = assert!(Position::SPACE == POSITION_TOTAL_LEN);

/// Fixture for the redemption and refund guard tests: an empty position that
/// has paid nothing in.
#[cfg(test)]
pub(crate) fn position_fixture() -> Position {
    Position {
        user: Pubkey::new_unique(),
        market: Pubkey::new_unique(),
        yes_shares: 0,
        no_shares: 0,
        locked_cost_usdc: 0,
        lock_nonce: 0,
        bump: 255,
        _reserved: [0u8; 32],
    }
}
