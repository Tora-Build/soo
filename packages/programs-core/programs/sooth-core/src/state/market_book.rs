//! `MarketBook` — per-market CLOB state.

use anchor_lang::prelude::*;

use crate::bitmap::TickBitmap;
use crate::state::{SIDE_AGAINST, SIDE_FOR};

#[account]
pub struct MarketBook {
    pub market: Pubkey,
    pub base_token_mint: Pubkey,
    pub registrar: Pubkey,
    pub next_order_id: u64,
    pub bitmap_for: [u64; 16],
    pub bitmap_against: [u64; 16],
    pub pending_fees: u128,
    pub pending_taker_payout: u128,
    pub _reserved: [u8; 32],
}

impl MarketBook {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 128 + 128 + 16 + 16 + 32;

    pub fn bitmap(&self, side: u8) -> &TickBitmap {
        match side {
            SIDE_FOR => TickBitmap::from_words(&self.bitmap_for),
            SIDE_AGAINST => TickBitmap::from_words(&self.bitmap_against),
            _ => panic!("invalid side"),
        }
    }

    pub fn bitmap_mut(&mut self, side: u8) -> &mut TickBitmap {
        match side {
            SIDE_FOR => TickBitmap::from_words_mut(&mut self.bitmap_for),
            SIDE_AGAINST => TickBitmap::from_words_mut(&mut self.bitmap_against),
            _ => panic!("invalid side"),
        }
    }
}
