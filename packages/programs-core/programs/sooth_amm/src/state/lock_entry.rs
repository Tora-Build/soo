//! `LockEntry` account — proceeds-locked-on-sell record. Architecture §4.3.
//!
//! Each AMM sell creates a fresh `LockEntry` PDA at
//! `[b"lock", market_id, user, nonce]`. The `claim_unlocked` instruction
//! (TODO; not in this scaffold) closes the account and refunds rent to the
//! user once `now ≥ unlock_at`.

use anchor_lang::prelude::*;

#[account]
pub struct LockEntry {
    pub user: Pubkey,
    pub market: Pubkey,

    /// USDC base units (6 decimals on Solana mainnet) escrowed at sell time.
    pub amount_usdc: u64,

    /// Unix timestamp at which `claim_unlocked` becomes callable.
    pub unlock_at: i64,

    /// Per-(user, market) monotonic nonce — part of the seed so multiple
    /// sells in flight don't collide on the same PDA.
    pub nonce: u64,

    pub bump: u8,
}

impl LockEntry {
    pub const SPACE: usize = 8   // discriminator
        + 32                     // user
        + 32                     // market
        + 8                      // amount_usdc
        + 8                      // unlock_at
        + 8                      // nonce
        + 1;                     // bump
}
