//! `BookSide` — per-tick resting order list for the CLOB.

use anchor_lang::prelude::*;

pub const SIDE_AGAINST: u8 = 0;
pub const SIDE_FOR: u8 = 1;

pub const MAX_ORDERS_PER_TICK: usize = 50;
// ── Raw byte offsets into a serialized `BookSide` account ────────────────
//
// `matching.rs` reads the header WITHOUT deserializing (it only has an
// `AccountInfo` for maker book sides passed via remaining_accounts), so these
// offsets are load-bearing. They used to be magic numbers inline in
// `read_book_side_header`, and inserting `_reserved` silently moved the Vec
// length prefix out from under `data[47..51]` — the matcher then read 4 zero
// bytes as `orders_len = 0` and every cross became a no-op that still
// succeeded. Named here, derived from each other, and covered by
// `header_offsets_match_the_encoding` below.
pub const BOOK_SIDE_MARKET_OFFSET: usize = 8; // after the discriminator
pub const BOOK_SIDE_SIDE_OFFSET: usize = BOOK_SIDE_MARKET_OFFSET + 32;
pub const BOOK_SIDE_TICK_OFFSET: usize = BOOK_SIDE_SIDE_OFFSET + 1;
pub const BOOK_SIDE_HEAD_INDEX_OFFSET: usize = BOOK_SIDE_TICK_OFFSET + 2;
pub const BOOK_SIDE_RESERVED_OFFSET: usize = BOOK_SIDE_HEAD_INDEX_OFFSET + 4;
pub const BOOK_SIDE_RESERVED_LEN: usize = 32;
/// Borsh writes a u32 length prefix before the `orders` Vec contents.
pub const BOOK_SIDE_ORDERS_LEN_OFFSET: usize =
    BOOK_SIDE_RESERVED_OFFSET + BOOK_SIDE_RESERVED_LEN;

/// Everything up to and including the Vec length prefix. The first
/// `InlineOrder` starts here.
pub const BOOK_SIDE_HEADER_SPACE: usize = BOOK_SIDE_ORDERS_LEN_OFFSET + 4;
pub const INLINE_ORDER_SPACE: usize = 60;

#[account]
pub struct BookSide {
    pub market: Pubkey,
    pub side: u8,
    pub tick: u16,
    pub head_index: u32,

    /// Forward-compat padding, placed BEFORE `orders` so the header stays a
    /// fixed-size prefix and the order list keeps a constant start offset.
    ///
    /// BookSide reallocs on every push, so growing it is not the problem —
    /// the problem is that a header field added later leaves every EXISTING
    /// BookSide account sized for the old header, and each one fails to
    /// deserialize. Padding buys header fields without that break.
    ///
    /// When you add a field, shrink this by exactly its serialized size and
    /// leave `BOOK_SIDE_HEADER_SPACE` unchanged.
    pub _reserved: [u8; BOOK_SIDE_RESERVED_LEN],

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

    /// `matching.rs` reads maker orders out of a raw `BookSide` account by
    /// slicing at `BOOK_SIDE_HEADER_SPACE + INLINE_ORDER_SPACE * i` — it never
    /// deserializes the struct. So these two constants are load-bearing in a
    /// way the compiler cannot check: get one wrong and the matcher silently
    /// reads misaligned bytes as an order (wrong maker, wrong amount) instead
    /// of failing.
    ///
    /// These tests derive both from the actual borsh encoding.
    #[test]
    fn inline_order_space_matches_its_encoding() {
        let order = InlineOrder {
            id: 7,
            maker: Pubkey::new_unique(),
            amount: 12_345,
            escrow: true,
            _pad: [0; 3],
        };
        assert_eq!(order.try_to_vec().unwrap().len(), INLINE_ORDER_SPACE);
    }

    #[test]
    fn header_space_matches_the_encoded_prefix() {
        let empty = BookSide {
            market: Pubkey::new_unique(),
            side: SIDE_FOR,
            tick: 900,
            head_index: 0,
            _reserved: [0; BOOK_SIDE_RESERVED_LEN],
            orders: vec![],
        };
        // try_to_vec omits the 8-byte account discriminator that
        // BOOK_SIDE_HEADER_SPACE accounts for.
        assert_eq!(empty.try_to_vec().unwrap().len() + 8, BOOK_SIDE_HEADER_SPACE);
    }

    #[test]
    fn space_for_matches_a_populated_account() {
        let order = InlineOrder {
            id: 1,
            maker: Pubkey::new_unique(),
            amount: 1,
            escrow: false,
            _pad: [0; 3],
        };
        for n in 0..4usize {
            let bs = BookSide {
                market: Pubkey::new_unique(),
                side: SIDE_AGAINST,
                tick: 1,
                head_index: 0,
                _reserved: [0; BOOK_SIDE_RESERVED_LEN],
                orders: vec![order.clone(); n],
            };
            assert_eq!(
                bs.try_to_vec().unwrap().len() + 8,
                BookSide::space_for(n),
                "space_for({n}) drifted from the encoding"
            );
        }
    }

    /// The test that was missing when `_reserved` was added, and whose absence
    /// let the matcher silently stop finding orders: the previous guards only
    /// checked the TOTAL header size and the first order's offset, both of
    /// which stayed self-consistent. What broke was an individual field offset
    /// inside the header. This pins every one of them against the real
    /// encoding.
    #[test]
    fn header_offsets_match_the_encoding() {
        let market = Pubkey::new_unique();
        let bs = BookSide {
            market,
            side: SIDE_FOR,
            tick: 0x0BAD,
            head_index: 0xDEAD_BEEF,
            _reserved: [0; BOOK_SIDE_RESERVED_LEN],
            orders: vec![
                InlineOrder {
                    id: 1,
                    maker: Pubkey::new_unique(),
                    amount: 1,
                    escrow: false,
                    _pad: [0; 3],
                };
                3
            ],
        };
        let mut d = vec![0u8; 8]; // stand-in discriminator
        d.extend(bs.try_to_vec().unwrap());

        assert_eq!(
            Pubkey::new_from_array(
                d[BOOK_SIDE_MARKET_OFFSET..BOOK_SIDE_MARKET_OFFSET + 32]
                    .try_into()
                    .unwrap()
            ),
            market,
        );
        assert_eq!(d[BOOK_SIDE_SIDE_OFFSET], SIDE_FOR);
        assert_eq!(
            u16::from_le_bytes(
                d[BOOK_SIDE_TICK_OFFSET..BOOK_SIDE_TICK_OFFSET + 2]
                    .try_into()
                    .unwrap()
            ),
            0x0BAD,
        );
        assert_eq!(
            u32::from_le_bytes(
                d[BOOK_SIDE_HEAD_INDEX_OFFSET..BOOK_SIDE_HEAD_INDEX_OFFSET + 4]
                    .try_into()
                    .unwrap()
            ),
            0xDEAD_BEEF,
        );
        // The one that regressed: a zero here means the matcher sees an empty
        // book and every cross becomes a silent no-op.
        assert_eq!(
            u32::from_le_bytes(
                d[BOOK_SIDE_ORDERS_LEN_OFFSET..BOOK_SIDE_ORDERS_LEN_OFFSET + 4]
                    .try_into()
                    .unwrap()
            ),
            3,
        );
        assert_eq!(
            d[BOOK_SIDE_RESERVED_OFFSET..BOOK_SIDE_RESERVED_OFFSET + BOOK_SIDE_RESERVED_LEN],
            [0u8; BOOK_SIDE_RESERVED_LEN],
        );
    }

    #[test]
    fn the_first_order_starts_exactly_at_the_header_boundary() {
        // The offset the matcher actually uses.
        let maker = Pubkey::new_unique();
        let bs = BookSide {
            market: Pubkey::new_unique(),
            side: SIDE_FOR,
            tick: 42,
            head_index: 0,
            _reserved: [0; BOOK_SIDE_RESERVED_LEN],
            orders: vec![InlineOrder {
                id: 0xABCD,
                maker,
                amount: 999,
                escrow: false,
                _pad: [0; 3],
            }],
        };
        let mut bytes = vec![0u8; 8]; // stand-in discriminator
        bytes.extend(bs.try_to_vec().unwrap());

        let slice = &bytes[BOOK_SIDE_HEADER_SPACE..BOOK_SIDE_HEADER_SPACE + INLINE_ORDER_SPACE];
        let decoded = InlineOrder::deserialize(&mut &slice[..]).unwrap();
        assert_eq!(decoded.id, 0xABCD);
        assert_eq!(decoded.maker, maker);
        assert_eq!(decoded.amount, 999);
    }
}
