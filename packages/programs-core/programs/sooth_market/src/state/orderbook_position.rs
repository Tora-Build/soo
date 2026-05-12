use anchor_lang::prelude::*;

#[account]
pub struct OrderbookPosition {
    pub market: Pubkey,
    pub user: Pubkey,
    pub yes_shares: u128,
    pub no_shares: u128,
    pub _reserved: [u8; 16],
}

impl OrderbookPosition {
    pub const SPACE: usize = 8 + 32 + 32 + 16 + 16 + 16;
}
