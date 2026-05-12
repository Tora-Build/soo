use anchor_lang::prelude::*;

#[event]
pub struct OrderPlaced {
    pub market: Pubkey,
    pub side: u8,
    pub tick: u16,
    pub maker: Pubkey,
    pub amount: u128,
    pub escrow: bool,
    pub order_id: u64,
}

#[event]
pub struct OrderCancelled {
    pub market: Pubkey,
    pub side: u8,
    pub tick: u16,
    pub maker: Pubkey,
    pub order_id: u64,
}

#[event]
pub struct DustOrderSkipped {
    pub market: Pubkey,
    pub side: u8,
    pub tick: u16,
    pub user: Pubkey,
    pub amount: u128,
    pub escrow: bool,
}
