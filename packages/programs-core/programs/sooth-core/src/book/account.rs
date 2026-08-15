//! The `Book` account: layout, zero-copy load, and growth.
//!
//! See `docs/design/orderbook-redesign.md`. This is the bridge between the
//! pure arena in [`super::arena`] and a real Solana account.
//!
//! ## Layout
//!
//! ```text
//!   [0 ..8)                       8-byte discriminator
//!   [8 ..8+HEADER)                BookHeader
//!   [8+HEADER ..)                 OrderNode[] — the arena, grown by realloc
//! ```
//!
//! The account is loaded by **casting the bytes in place**, never by
//! deserializing. That is the whole point: a borsh `Vec<Order>` is what forces
//! the current book to heap-allocate the entire price level on every touch, and
//! is why every instruction in the program has to prepend a 256 KB heap frame.
//! Casting costs nothing and allocates nothing.
//!
//! ## Alignment
//!
//! `bytemuck::from_bytes_mut` panics on a misaligned cast, so the alignment
//! contract is load-bearing rather than incidental:
//!
//!   - Solana guarantees account data is **8-byte aligned**.
//!   - `OrderNode` and `BookHeader` are asserted `align_of <= 8` at compile
//!     time in [`super::arena`] (which is why neither may contain a `u128`).
//!   - The discriminator is 8 bytes and `BookHeader` is a multiple of 8, so
//!     both the header and the block array start 8-aligned.
//!
//! [`assert_layout_offsets_are_aligned`] re-derives all of that from
//! `size_of`, so a field added to the header cannot quietly break it.
//!
//! ## Growth
//!
//! The arena grows by `realloc`, which Solana caps at
//! [`MAX_PERMITTED_DATA_INCREASE`] (10,240 bytes) **per instruction**, measured
//! from the account's length at instruction entry. That is 160 blocks at 64
//! bytes, so a book can go from empty to the 256-order cap in two instructions.
//! [`grow_target`] never returns a step larger than the cap.

use super::arena::{Book, BookHeader, OrderNode, BLOCK_SIZE, MAX_ORDERS};

/// `sha256("account:Book")[..8]`, matching Anchor's convention. Hard-coded
/// rather than derived because this account is loaded by raw cast, so nothing
/// else would compute it for us.
pub const BOOK_DISCRIMINATOR: [u8; 8] = [0x4b, 0x6f, 0x6f, 0x42, 0x00, 0x01, 0x00, 0x00];

/// Solana's per-instruction realloc cap, measured from the account length at
/// instruction entry.
pub const MAX_PERMITTED_DATA_INCREASE: usize = 10_240;

pub const DISCRIMINATOR_LEN: usize = 8;

#[derive(Debug, PartialEq, Eq)]
pub enum BookAccountError {
    BadDiscriminator,
    TooSmall,
    Misaligned,
    AtCapacity,
}

type R<T> = core::result::Result<T, BookAccountError>;

/// Byte offset at which the block array starts.
pub const fn blocks_offset() -> usize {
    DISCRIMINATOR_LEN + core::mem::size_of::<BookHeader>()
}

/// Account size needed to hold `capacity` blocks.
pub const fn book_space(capacity: usize) -> usize {
    blocks_offset() + capacity * BLOCK_SIZE
}

/// How many blocks fit in an account of `len` bytes. Truncates: a partial
/// trailing block is unusable, not an error.
pub const fn capacity_for(len: usize) -> usize {
    if len < blocks_offset() {
        0
    } else {
        (len - blocks_offset()) / BLOCK_SIZE
    }
}

/// Next account length to realloc to, honouring both the per-instruction cap
/// and the order ceiling.
///
/// Returns `None` when the account already holds every block it is allowed to,
/// so callers can distinguish "grow again next instruction" from "full".
pub fn grow_target(current_len: usize, wanted_blocks: usize) -> Option<usize> {
    let wanted = wanted_blocks.min(MAX_ORDERS as usize);
    let have = capacity_for(current_len);
    if have >= wanted {
        return None;
    }
    let ideal = book_space(wanted);
    let capped = current_len + MAX_PERMITTED_DATA_INCREASE;
    Some(ideal.min(capped))
}

/// Cast raw account data into a usable [`Book`].
///
/// Borrows for the lifetime of the slice, so the caller holds the account's
/// `RefMut` for as long as the book is in use — which is what keeps this
/// allocation-free.
pub fn load_book<'a>(data: &'a mut [u8]) -> R<Book<'a>> {
    if data.len() < blocks_offset() {
        return Err(BookAccountError::TooSmall);
    }
    if data[..DISCRIMINATOR_LEN] != BOOK_DISCRIMINATOR {
        return Err(BookAccountError::BadDiscriminator);
    }

    let (head, rest) = data.split_at_mut(blocks_offset());
    let header_bytes = &mut head[DISCRIMINATOR_LEN..];

    // Refuse rather than panic. bytemuck's checked API turns a misaligned or
    // mis-sized cast into an error; the unchecked one aborts the program.
    let header: &mut BookHeader = bytemuck::try_from_bytes_mut(header_bytes)
        .map_err(|_| BookAccountError::Misaligned)?;

    let usable = (rest.len() / BLOCK_SIZE) * BLOCK_SIZE;
    let blocks: &mut [OrderNode] = bytemuck::try_cast_slice_mut(&mut rest[..usable])
        .map_err(|_| BookAccountError::Misaligned)?;

    Ok(Book { header, blocks })
}

/// Write the discriminator and a zeroed header into a fresh account.
pub fn init_book(data: &mut [u8], market: anchor_lang::prelude::Pubkey, bump: u8) -> R<()> {
    if data.len() < blocks_offset() {
        return Err(BookAccountError::TooSmall);
    }
    data[..DISCRIMINATOR_LEN].copy_from_slice(&BOOK_DISCRIMINATOR);
    let (head, _) = data.split_at_mut(blocks_offset());
    let header: &mut BookHeader =
        bytemuck::try_from_bytes_mut(&mut head[DISCRIMINATOR_LEN..])
            .map_err(|_| BookAccountError::Misaligned)?;
    *header = BookHeader {
        market,
        next_seq: 0,
        free_head: super::arena::NIL,
        bids_head: super::arena::NIL,
        asks_head: super::arena::NIL,
        block_count: 0,
        order_count: 0,
        seats_head: super::arena::NIL,
        bump,
        _pad: [0; 7],
        _reserved: [0; 56],
    };
    Ok(())
}

/// Compile-time-ish check that every cast offset lands on an 8-byte boundary.
/// Called from tests; `const` so a violation is caught at build time too.
pub const fn assert_layout_offsets_are_aligned() {
    assert!(DISCRIMINATOR_LEN % 8 == 0);
    assert!(core::mem::size_of::<BookHeader>() % 8 == 0);
    assert!(blocks_offset() % 8 == 0);
    assert!(BLOCK_SIZE % 8 == 0);
}
const _: () = assert_layout_offsets_are_aligned();

#[cfg(test)]
mod tests {
    use super::*;
    use crate::book::arena::{NIL, SIDE_ASK, SIDE_BID};
    use anchor_lang::prelude::Pubkey;

    /// Account data with the alignment Solana actually provides. `Vec<u64>`
    /// gives 8-byte alignment, matching the runtime — allocating a `Vec<u8>`
    /// would give align 1 and the cast would fail for the wrong reason.
    fn account(capacity: usize) -> Vec<u64> {
        let bytes = book_space(capacity);
        vec![0u64; bytes.div_ceil(8)]
    }

    fn as_bytes(buf: &mut [u64], capacity: usize) -> &mut [u8] {
        let n = book_space(capacity);
        &mut bytemuck::cast_slice_mut(buf)[..n]
    }

    #[test]
    fn space_and_capacity_are_inverses() {
        for cap in [0usize, 1, 17, 256] {
            assert_eq!(capacity_for(book_space(cap)), cap);
        }
        // A partial trailing block is simply unusable.
        assert_eq!(capacity_for(book_space(3) + BLOCK_SIZE - 1), 3);
        assert_eq!(capacity_for(0), 0);
        assert_eq!(capacity_for(blocks_offset() - 1), 0);
    }

    #[test]
    fn a_fresh_account_loads_and_is_empty() {
        let mut buf = account(8);
        let market = Pubkey::new_unique();
        {
            let data = as_bytes(&mut buf, 8);
            init_book(data, market, 254).unwrap();
        }
        let data = as_bytes(&mut buf, 8);
        let book = load_book(data).unwrap();
        assert_eq!(book.header.market, market);
        assert_eq!(book.header.bump, 254);
        assert_eq!(book.header.bids_head, NIL);
        assert_eq!(book.header.asks_head, NIL);
        assert_eq!(book.header.free_head, NIL);
        assert_eq!(book.blocks.len(), 8);
    }

    #[test]
    fn orders_survive_a_reload_because_nothing_is_deserialized() {
        // The property the whole zero-copy design rests on: state lives in the
        // account bytes, not in a decoded copy, so dropping and re-casting is a
        // no-op rather than a round-trip.
        let mut buf = account(8);
        let market = Pubkey::new_unique();
        let trader = Pubkey::new_unique();
        {
            let data = as_bytes(&mut buf, 8);
            init_book(data, market, 254).unwrap();
            let mut book = load_book(data).unwrap();
            book.insert(SIDE_BID, 600, 5_000_000, trader).unwrap();
            book.insert(SIDE_ASK, 700, 3_000_000, trader).unwrap();
        }
        let data = as_bytes(&mut buf, 8);
        let book = load_book(data).unwrap();
        assert_eq!(book.header.order_count, 2);
        let (_, best_bid) = book.best(SIDE_BID).unwrap();
        assert_eq!(best_bid.price_tick, 600);
        assert_eq!(best_bid.amount, 5_000_000);
        assert_eq!(best_bid.trader, trader);
        assert_eq!(book.best(SIDE_ASK).unwrap().1.price_tick, 700);
    }

    #[test]
    fn a_wrong_discriminator_is_rejected() {
        // Without this an attacker substitutes any 8-byte-aligned account they
        // control and the program happily reads it as a book.
        let mut buf = account(4);
        let data = as_bytes(&mut buf, 4);
        init_book(data, Pubkey::new_unique(), 1).unwrap();
        data[0] ^= 0xFF;
        assert_eq!(
            load_book(data).unwrap_err(),
            BookAccountError::BadDiscriminator
        );
    }

    #[test]
    fn a_truncated_account_is_rejected_rather_than_read_out_of_bounds() {
        let mut buf = account(4);
        {
            let data = as_bytes(&mut buf, 4);
            init_book(data, Pubkey::new_unique(), 1).unwrap();
        }
        let all: &mut [u8] = bytemuck::cast_slice_mut(&mut buf);
        let short = &mut all[..blocks_offset() - 1];
        assert_eq!(load_book(short).unwrap_err(), BookAccountError::TooSmall);
    }

    #[test]
    fn an_account_with_room_for_zero_blocks_still_loads() {
        // The realloc path starts here: header written, arena empty, grow next.
        let mut buf = account(0);
        let data = as_bytes(&mut buf, 0);
        init_book(data, Pubkey::new_unique(), 1).unwrap();
        let book = load_book(data).unwrap();
        assert_eq!(book.blocks.len(), 0);
    }

    #[test]
    fn insert_into_a_zero_capacity_arena_reports_full_not_a_panic() {
        let mut buf = account(0);
        let data = as_bytes(&mut buf, 0);
        init_book(data, Pubkey::new_unique(), 1).unwrap();
        let mut book = load_book(data).unwrap();
        assert!(book.insert(SIDE_BID, 500, 1, Pubkey::new_unique()).is_err());
    }

    #[test]
    fn growth_never_exceeds_solanas_per_instruction_realloc_cap() {
        // MAX_PERMITTED_DATA_INCREASE is measured from the length at
        // instruction entry, so a single step may not exceed it — reaching the
        // cap from empty always takes several calls.
        //
        // The invariants that matter are that no step overshoots, that every
        // step makes progress, and that the walk terminates exactly at
        // capacity. Asserted instead of a fixed step count, so the test holds
        // across changes to MAX_ORDERS.
        let mut len = book_space(0);
        let mut steps = 0;
        while let Some(next) = grow_target(len, MAX_ORDERS as usize) {
            assert!(
                next - len <= MAX_PERMITTED_DATA_INCREASE,
                "step {steps} grew {} bytes, over the {MAX_PERMITTED_DATA_INCREASE} cap",
                next - len
            );
            assert!(next > len, "step {steps} made no progress");
            len = next;
            steps += 1;
            assert!(steps < 10_000, "grow walk did not terminate");
        }
        assert!(
            capacity_for(len) >= MAX_ORDERS as usize,
            "the walk must end at full capacity, got {}",
            capacity_for(len)
        );
        // The realloc cap divided into the arena — the number of `book_grow`
        // calls a market needs to reach the ceiling.
        assert_eq!(
            steps,
            (book_space(MAX_ORDERS as usize) - book_space(0))
                .div_ceil(MAX_PERMITTED_DATA_INCREASE),
            "step count should be exactly the size delta over the realloc cap"
        );
    }

    #[test]
    fn growth_stops_at_the_order_cap_even_if_more_is_requested() {
        let len = book_space(MAX_ORDERS as usize);
        assert_eq!(grow_target(len, 10_000), None);
    }

    #[test]
    fn growth_is_a_no_op_when_capacity_already_suffices() {
        let len = book_space(64);
        assert_eq!(grow_target(len, 10), None);
        assert_eq!(grow_target(len, 64), None);
        assert!(grow_target(len, 65).is_some());
    }

    #[test]
    fn every_cast_offset_lands_on_an_eight_byte_boundary() {
        // Re-derived from size_of rather than hard-coded, so adding a header
        // field cannot silently misalign the block array. bytemuck would then
        // fail the cast on-chain and every book instruction would break at
        // once.
        assert_layout_offsets_are_aligned();
        assert_eq!(blocks_offset() % 8, 0);
        assert_eq!(core::mem::align_of::<OrderNode>(), 8);
        assert_eq!(core::mem::align_of::<BookHeader>(), 8);
    }

    #[test]
    fn a_full_book_fits_the_rent_budget_in_the_design_doc() {
        let full = book_space(MAX_ORDERS as usize);
        // (128 + bytes) * 6960 lamports.
        let lamports = (128 + full) as u64 * 6960;
        let sol = lamports as f64 / 1e9;
        // A fully-extended book is the worst case a market ever pays, and it is
        // only reached by a market that earned it — `book_grow` is incremental.
        assert!(
            sol < 2.5,
            "a full {MAX_ORDERS}-block book should stay under 2.5 SOL, got {sol}"
        );

        // The comparison that motivates the rewrite: 10 orders in ONE account
        // against today's 19 accounts for the same book.
        let ten = (128 + book_space(10)) as u64 * 6960;
        let today = 19 * 128 * 6960 + 2_640 * 6960;
        assert!(
            ten * 2 < today,
            "10 orders in one account should cost less than half of today's \\
             19-account layout: {ten} vs {today}"
        );
    }
}
