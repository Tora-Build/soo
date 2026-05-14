//! `OrderbookPosition` — per-(user, market) share ledger for the CLOB.
//!
//! Copied verbatim from `sooth_market::state::OrderbookPosition`. Seeds and
//! layout are unchanged; the owning program is now `sooth_core`.

use anchor_lang::prelude::*;

#[account]
pub struct OrderbookPosition {
    pub market: Pubkey,
    pub user: Pubkey,
    /// WAD-scaled YES share balance.
    pub yes_shares: u128,
    /// WAD-scaled NO share balance.
    pub no_shares: u128,
    pub _reserved: [u8; 16],
}

impl OrderbookPosition {
    /// Seeds: `[b"orderbook_position", market_id, user]` under `sooth_core::ID`.
    pub const SPACE: usize = 8 + 32 + 32 + 16 + 16 + 16;
}
