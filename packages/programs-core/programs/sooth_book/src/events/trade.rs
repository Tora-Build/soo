use anchor_lang::prelude::*;

#[event]
pub struct TradeEvent {
    pub amount: u64,
    pub price: u128,
    pub market: Pubkey,
}
