use anchor_lang::prelude::*;

pub const MAX_ORDERS_PER_TICK: usize = 50;
pub const BOOK_SIDE_HEADER_SPACE: usize = 51;
pub const INLINE_ORDER_SPACE: usize = 60;

#[account]
pub struct BookSide {
    pub market: Pubkey,
    pub side: u8,
    pub tick: u16,
    pub head_index: u32,
    pub orders: Vec<InlineOrder>,
}

impl BookSide {
    pub fn space_for(n_orders: usize) -> usize {
        BOOK_SIDE_HEADER_SPACE + INLINE_ORDER_SPACE * n_orders
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InlineOrder {
    pub id: u64,
    pub maker: Pubkey,
    pub amount: u128,
    pub escrow: bool,
    pub _pad: [u8; 3],
}
