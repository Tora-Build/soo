//! `LpPosition` — per-(creator, market) LP claim record.

use anchor_lang::prelude::*;

#[account]
pub struct LpPosition {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub lp_mint: Pubkey,
    /// Creator's seed deposit in WAD (bookkeeping for dismiss/refund flow).
    pub seed_deposit_wad: u128,
    /// Unix seconds at which the market graduated. 0 = not graduated.
    pub graduated_at: i64,
    pub bump: u8,

    /// Forward-compat padding. Adding a field consumes bytes from here
    /// instead of changing the account's length, so no migration is needed:
    /// Solana accounts are fixed-length buffers, and an `#[account]` struct
    /// that outgrows its buffer fails to deserialize on every instruction
    /// that loads it. (Unlike EVM, where appending a storage slot is free.)
    ///
    /// When you add a field, shrink this by exactly its serialized size and
    /// leave `SPACE` unchanged.
    /// Subsidy already reclaimed after settlement, in USDC base units.
    ///
    /// Carved out of `_reserved` (32 -> 24), so `SPACE` is unchanged and no
    /// account needs migrating. Tracks the running total because
    /// `reclaim_subsidy` is callable more than once: obligations shrink as
    /// traders redeem, so the free residual grows over time and a creator
    /// should not have to guess when to make their single call.
    pub reclaimed_base: u64,

    pub _reserved: [u8; 24],
}

impl LpPosition {
    /// Seeds: `[b"lp_position", market_id, creator]` under `sooth_core::ID`.
    pub const SPACE: usize = 8     // discriminator
        + 32                       // market
        + 32                       // creator
        + 32                       // lp_mint
        + 16                       // seed_deposit_wad
        + 8                        // graduated_at
        + 1                        // bump
        + 8                        // reclaimed_base
        + 24; // _reserved
}
