//! `LockEntry` — 24h lock escrow for AMM sell proceeds.

use anchor_lang::prelude::*;

use crate::constants::LOCK_ENTRY_TOTAL_LEN;

#[account]
pub struct LockEntry {
    pub user: Pubkey,
    pub market: Pubkey,
    /// USDC amount locked (net proceeds after sell fee).
    pub amount_usdc: u64,
    /// Unix timestamp when the lock matures and `claim_unlocked` may proceed.
    pub unlock_at: i64,
    /// Nonce copied from `Position.lock_nonce` at sell time. Used to derive
    /// the PDA seed so each sell creates a unique LockEntry.
    pub nonce: u64,
    pub bump: u8,
}

impl LockEntry {
    /// Seeds: `[b"lock_entry", position.key(), nonce.to_le_bytes()]` under
    /// `sooth_core::ID`.
    pub const SPACE: usize = 8     // discriminator
        + 32                       // user
        + 32                       // market
        + 8                        // amount_usdc
        + 8                        // unlock_at
        + 8                        // nonce
        + 1; // bump
}

/// Compile-time assert: LockEntry::SPACE must match LOCK_ENTRY_TOTAL_LEN.
const _: () = assert!(LockEntry::SPACE == LOCK_ENTRY_TOTAL_LEN);
