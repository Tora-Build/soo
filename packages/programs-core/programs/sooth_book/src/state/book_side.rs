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

#[cfg(test)]
mod tests {
    use super::*;
    use sooth_protocol_types::ids::{SOOTH_LAUNCHPAD_PROGRAM_ID, SOOTH_MARKET_PROGRAM_ID};

    #[test]
    fn print_pda_parity_fixtures_for_sdk() {
        let market_id = [
            0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
            0xcd, 0xef,
        ];
        let user = Pubkey::new_from_array([
            0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42,
            0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42,
            0x42, 0x42, 0x42, 0x42,
        ]);
        let tick = 500u16;
        let side = 1u8;
        let tick_bytes = tick.to_le_bytes();
        let side_bytes = [side];

        let (market_book, _) =
            Pubkey::find_program_address(&[b"market_book", market_id.as_ref()], &crate::ID);
        let (book_side, _) = Pubkey::find_program_address(
            &[
                b"book_side",
                market_id.as_ref(),
                side_bytes.as_ref(),
                tick_bytes.as_ref(),
            ],
            &crate::ID,
        );
        let (orderbook_position, _) = Pubkey::find_program_address(
            &[b"orderbook_position", market_id.as_ref(), user.as_ref()],
            &SOOTH_MARKET_PROGRAM_ID,
        );
        let (market_fee_pool, _) = Pubkey::find_program_address(
            &[b"market_fee_pool", market_id.as_ref()],
            &SOOTH_LAUNCHPAD_PROGRAM_ID,
        );

        println!("market_id=1032547698badcfe0123456789abcdef");
        println!("market_book={market_book}");
        println!("book_side={book_side}");
        println!("orderbook_position={orderbook_position}");
        println!("market_fee_pool={market_fee_pool}");

        assert_eq!(
            market_book.to_string(),
            "BzfZpzVXn1MViui2MamX5u1zTLkH5i6a6bYXnUM8NDZD"
        );
        assert_eq!(
            book_side.to_string(),
            "4Ne6sVgcNSfsktHyZAc5uvnHP9kx2upCwd5RJLsX7ggU"
        );
        assert_eq!(
            orderbook_position.to_string(),
            "4TsxBcZbWhcmhjdm2Sd9g5e7taAR8Ksgm98UjxwAxjdE"
        );
        assert_eq!(
            market_fee_pool.to_string(),
            "3iFiddMBgP7YjU65MiCeVUqADSmzF36NMjRhhHA3fmuC"
        );
    }
}
