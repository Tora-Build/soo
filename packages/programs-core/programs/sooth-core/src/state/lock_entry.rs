//! `LockEntry` — 24h lock escrow for AMM sell proceeds.
//!
//! ## T\* voiding, and why this account is the whole story
//!
//! A trader who DUMPS a soon-to-be-worthless position after T\* is making the
//! same informed trade as one who buys, and the buy side is voided. The sell
//! side is not, and this account is why: the proceeds leave the AMM's
//! accounting at sell time and sit here, and `claim_unlocked` pays them out
//! with no reference to any commitment.
//!
//! What is NOT missing is the evidence. [`LockEntry::sold_at`] recovers the
//! moment of the sell exactly, from a field this account already stores, so a
//! claw-back needs no new state and no merkle leaf — only a comparison against
//! the commitment's `t_star` inside `claim_unlocked`. What bounds how much
//! that could ever recover is timing, not information: see `sold_at`.

use anchor_lang::prelude::*;

use crate::constants::LOCK_ENTRY_TOTAL_LEN;
use crate::instructions::sell_positions::LOCK_DURATION_SECS;

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

impl LockEntry {
    /// The instant the sell happened.
    ///
    /// Derived, not stored: `unlock_at` is written as `now +
    /// LOCK_DURATION_SECS` at exactly one site (`sell_positions`), so the
    /// subtraction is exact for every entry this program has ever created, and
    /// costs no bytes on an account whose length may not change.
    ///
    /// This is the number a post-T\* claw-back turns on — `sold_at > t_star`
    /// is the whole test — which is why it lives here rather than in the
    /// instruction that would use it.
    pub fn sold_at(&self) -> i64 {
        self.unlock_at.saturating_sub(LOCK_DURATION_SECS)
    }

    /// Are these proceeds still escrowed at `now`?
    ///
    /// The bound on what a claw-back could recover, and the reason gap (2) is
    /// only PARTLY solvable: a commitment publishes inside the veto window
    /// that follows the attestation, which follows the lock, which follows
    /// every sell. A sell more than `LOCK_DURATION_SECS` before that moment
    /// has already matured and may already have been claimed, and no gate in
    /// `claim_unlocked` can reach money that has left. A gate catches exactly
    /// the sells still inside their cooldown when the commitment lands — which
    /// is all of them when the adjudicator locks, attests and publishes
    /// promptly, and none of them when it takes longer than a day.
    pub fn is_escrowed_at(&self, now: i64) -> bool {
        now < self.unlock_at
    }

    /// Seeds: `[b"lock_entry", position.key(), nonce.to_le_bytes()]` under
    /// `sooth_core::ID`.
    pub const SPACE: usize = 8     // discriminator
        + 32                       // user
        + 32                       // market
        + 8                        // amount_usdc
        + 8                        // unlock_at
        + 8                        // nonce
        + 1                        // bump
        + 32; // _reserved
}

/// Compile-time assert: LockEntry::SPACE must match LOCK_ENTRY_TOTAL_LEN.
const _: () = assert!(LockEntry::SPACE == LOCK_ENTRY_TOTAL_LEN);

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(unlock_at: i64) -> LockEntry {
        LockEntry {
            user: Pubkey::new_unique(),
            market: Pubkey::new_unique(),
            amount_usdc: 1_000_000,
            unlock_at,
            nonce: 3,
            bump: 254,
            _reserved: [0u8; 32],
        }
    }

    #[test]
    fn the_sell_time_is_recoverable_from_the_unlock_time() {
        // The one write site is `sell_positions`, which stores
        // `now + LOCK_DURATION_SECS`. If that ever stops being true, a
        // claw-back built on `sold_at` would compare against the wrong
        // instant, so the relationship is pinned here.
        let sold = 1_700_000_000;
        assert_eq!(entry(sold + LOCK_DURATION_SECS).sold_at(), sold);
    }

    #[test]
    fn a_sell_after_t_star_is_distinguishable_from_one_before_it() {
        // The whole test a claw-back would need, and it needs no new state.
        let t_star = 1_700_000_000;
        let early = entry(t_star - 1 + LOCK_DURATION_SECS);
        let late = entry(t_star + 1 + LOCK_DURATION_SECS);
        assert!(early.sold_at() <= t_star);
        assert!(late.sold_at() > t_star);
    }

    #[test]
    fn proceeds_are_escrowed_only_until_they_mature() {
        // What bounds the claw-back: money already claimable is out of reach.
        let e = entry(1_000);
        assert!(e.is_escrowed_at(999));
        assert!(!e.is_escrowed_at(1_000));
        assert!(!e.is_escrowed_at(1_001));
    }
}
