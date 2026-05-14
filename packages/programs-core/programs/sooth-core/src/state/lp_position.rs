//! `LpPosition` — per-(creator, market) LP claim record.
//!
//! Copied verbatim from `sooth_launchpad::state::LpPosition`.

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
}

impl LpPosition {
    /// Seeds: `[b"lp_position", market_id, creator]` under `sooth_core::ID`.
    pub const SPACE: usize = 8     // discriminator
        + 32                       // market
        + 32                       // creator
        + 32                       // lp_mint
        + 16                       // seed_deposit_wad
        + 8                        // graduated_at
        + 1; // bump
}
