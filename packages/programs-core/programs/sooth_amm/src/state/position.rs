//! `Position` account — per-(user, market). Architecture §2.3.
//!
//! Created lazily on the user's first trade via `init_if_needed` in
//! `trade_positions`. Rent (~0.002 SOL) is paid by the user; refundable on
//! `close_position` once both sides are zero (TODO instruction).

use anchor_lang::prelude::*;

#[account]
pub struct Position {
    pub user: Pubkey,
    pub market: Pubkey,

    /// Outstanding YES shares the user holds, WAD. Always ≥ 0.
    pub yes_shares: i128,
    /// Outstanding NO shares the user holds, WAD. Always ≥ 0.
    pub no_shares: i128,

    pub bump: u8,
}

impl Position {
    pub const SPACE: usize = 8   // discriminator
        + 32                     // user
        + 32                     // market
        + 16 + 16                // yes_shares, no_shares
        + 1;                     // bump
}
