//! Block arena for the redesigned orderbook.
//!
//! One account per market holds a fixed header followed by a flat array of
//! uniform 80-byte blocks. Orders are allocated from a free list inside that
//! array, and the two sides are intrusive sorted doubly-linked lists threaded
//! through the same blocks.
//!
//! ## Why this shape
//!
//! Today's book is one PDA per `(market, side, tick)`. Rent on Solana is
//! `(128 + bytes) * 6960` lamports, so **every account carries a 128-byte
//! surcharge** — about $0.178. A thin book of 10 orders across 8 ticks is 19
//! accounts and ~$7.06, of which $3.38 is pure per-account overhead. Splitting
//! state across accounts is what costs money, not the bytes.
//!
//! Worse, each of those accounts must be named, locked, and passed into the
//! transaction, which is what caps a crossing buy at 5 fills: 3 accounts and 99
//! bytes per fill against a 1232-byte packet limit.
//!
//! Consolidating into one account removes both problems at once. Phoenix does
//! this but preallocates (0.59-12 SOL per market); Manifest does it with
//! uniform blocks grown by `realloc` (0.0073 SOL). We are a launchpad with many
//! thin markets, so we follow Manifest.
//!
//! ## Ordering
//!
//! Strict **price-time priority**, maintained explicitly on insert. Bids sort
//! by descending price, asks by ascending price, and both break ties by
//! ascending `seq` — so at equal price the earlier order is always closer to
//! the head, and the matcher can simply walk from the head.
//!
//! Today FIFO is a free consequence of appending to a per-tick `Vec`. Here it
//! is real logic, so it gets a real test: `insert_remove_preserves_price_time`
//! drives thousands of randomised operations and re-verifies the ordering, the
//! free list, and the block count after every single one.
//!
//! ## Why a linked list and not a red-black tree
//!
//! Insert is O(n). For the book sizes a prediction market actually sees (tens
//! of orders) that is a few hundred CU of pointer chasing, against ~600 lines
//! for a balanced tree. The block layout is deliberately tree-compatible —
//! `next`/`prev` become child pointers — so the index can be swapped later
//! without touching the arena, the settlement layer, or the wire format.
//! Ship the list; earn the tree.

use anchor_lang::prelude::Pubkey;
use anchor_lang::zero_copy;

/// This module deliberately uses `core::result::Result`, not Anchor's
/// single-generic `Result` alias: the arena is pure data-structure code with
/// its own error type and no `ProgramError` surface.
type BookResult<T> = core::result::Result<T, BookError>;

/// Sentinel for "no block". `u32::MAX` rather than 0, because 0 is a valid
/// block index and a zeroed account would otherwise look like a list of one.
pub const NIL: u32 = u32::MAX;

/// Uniform block size. Everything in the arena is exactly this, so a block can
/// be recycled as any kind of node without fragmentation.
pub const BLOCK_SIZE: usize = 64;

/// Ceiling on live orders per market. Bounds both the O(n) insert walk and the
/// realloc-grief surface; 256 blocks is ~20 KB, about $2.9 of rent fully
/// extended.
pub const MAX_ORDERS: u32 = 256;

pub const SIDE_BID: u8 = 0; // buying YES
pub const SIDE_ASK: u8 = 1; // selling YES (equivalently: buying NO)

/// One order.
///
/// **No `u128` anywhere, deliberately.** `u128` has 16-byte alignment, and
/// Solana account data is only guaranteed 8-byte aligned — a `bytemuck` cast of
/// a 16-aligned type onto account data fails at runtime. Worse, the alignment
/// is not guaranteed identical between the host (where these tests run) and
/// SBF, so a `u128` field could give a layout that passes `cargo test` and is
/// wrong on-chain. Phoenix's order-tree node is 64 bytes for the same reason.
///
/// So `amount` is a `u64` in **USDC base units** (6 decimals), where one share
/// is 1_000_000 and redeems for 1.00 USDC. u64 holds ~1.8e13 shares, far past
/// any market. This also removes WAD→base rounding from the storage layer
/// entirely: the book speaks the same units as the vault.
#[zero_copy]
#[derive(Debug)]
pub struct OrderNode {
    /// Unfilled size, USDC base units.
    pub amount: u64,
    pub trader: Pubkey,
    /// Monotonic per-market sequence. Lower = earlier = higher time priority.
    pub seq: u64,
    /// Next block in the side list, or `NIL`. Doubles as the free-list link
    /// while the block is free.
    pub next: u32,
    pub prev: u32,
    pub price_tick: u16,
    pub side: u8,
    pub flags: u8,
    pub _pad: [u8; 4],
}

/// A trader's ledger entry, sharing the block array with orders.
///
/// Two node kinds in one arena is what keeps a fill free of extra accounts:
/// crediting a maker is a write inside the book account we already hold, not a
/// second account to name, lock and pass in. That is the whole reason a fill
/// costs 3 accounts and 99 transaction bytes today and 0 of each here.
///
/// `kind` sits at the **same byte offset** as `OrderNode::flags` so a block can
/// be identified before it is interpreted; the offsets are asserted below.
#[zero_copy]
#[derive(Debug)]
pub struct SeatNode {
    /// Withdrawable USDC base units. Fills credit this; `withdraw` drains it.
    pub credit: u64,
    pub trader: Pubkey,
    /// Signed position: `> 0` long YES, `< 0` long NO.
    pub net: i64,
    /// Next seat, or `NIL`.
    pub next: u32,
    pub _pad0: [u8; 7],
    /// Must equal [`KIND_SEAT`]. Shares an offset with `OrderNode::flags`.
    pub kind: u8,
    pub _pad1: [u8; 4],
}

pub const KIND_ORDER: u8 = 0;
pub const KIND_SEAT: u8 = 1;

const _: () = assert!(core::mem::size_of::<OrderNode>() == BLOCK_SIZE);
const _: () = assert!(core::mem::size_of::<SeatNode>() == BLOCK_SIZE);
const _: () = assert!(core::mem::align_of::<SeatNode>() <= 8);
// `kind` and `flags` must share a byte offset, or a block cannot be identified
// before it is interpreted and a seat could be read as an order.
const _: () = assert!(core::mem::offset_of!(OrderNode, flags) == core::mem::offset_of!(SeatNode, kind));
// The alignment contract with Solana's account data. If this ever exceeds 8 the
// zero-copy cast stops being sound on-chain.
const _: () = assert!(core::mem::align_of::<OrderNode>() <= 8);
const _: () = assert!(core::mem::align_of::<BookHeader>() <= 8);

/// Fixed prefix of the book account. The rest of the account data is a flat
/// `[OrderNode]` addressed by index.
#[zero_copy]
#[derive(Debug)]
pub struct BookHeader {
    pub market: Pubkey,
    pub next_seq: u64,
    /// Head of the free list, or `NIL`.
    pub free_head: u32,
    /// Best bid first (highest price, then earliest seq).
    pub bids_head: u32,
    /// Best ask first (lowest price, then earliest seq).
    pub asks_head: u32,
    /// Blocks handed out of the arena so far, free or live. The high-water
    /// mark — never decreases, because freed blocks go on the free list.
    pub block_count: u32,
    /// Live orders across both sides.
    pub order_count: u32,
    /// Head of the seat list, or `NIL`.
    pub seats_head: u32,
    pub bump: u8,
    pub _pad: [u8; 7],
    pub _reserved: [u8; 56],
}

/// Reinterpret a block as a seat. Safe because both types are `Pod`, the same
/// size, and equally aligned — the cast cannot fail, only be meaningless, which
/// is what `kind` guards.
#[inline]
pub fn as_seat(node: &OrderNode) -> &SeatNode {
    bytemuck::cast_ref(node)
}

#[inline]
pub fn as_seat_mut(node: &mut OrderNode) -> &mut SeatNode {
    bytemuck::cast_mut(node)
}

/// A book: a header plus its block array. Borrowed rather than owned so the
/// on-chain path can hand it the account's data slice directly, with no copy
/// and no heap allocation.
#[derive(Debug)]
pub struct Book<'a> {
    pub header: &'a mut BookHeader,
    pub blocks: &'a mut [OrderNode],
}

#[derive(Debug, PartialEq, Eq)]
pub enum BookError {
    Full,
    NotFound,
    InvalidIndex,
    InvalidSide,
}

impl<'a> Book<'a> {
    /// Allocate a block: reuse a freed one, else extend into untouched arena.
    pub(crate) fn alloc_block(&mut self) -> BookResult<u32> {
        if self.header.free_head != NIL {
            let idx = self.header.free_head;
            let node = self.node(idx)?;
            self.header.free_head = node.next;
            return Ok(idx);
        }
        let idx = self.header.block_count;
        if idx >= MAX_ORDERS || (idx as usize) >= self.blocks.len() {
            return Err(BookError::Full);
        }
        self.header.block_count += 1;
        Ok(idx)
    }

    fn free(&mut self, idx: u32) -> BookResult<()> {
        let free_head = self.header.free_head;
        let node = self.node_mut(idx)?;
        // Zero the payload so a recycled block can never surface a stale
        // trader or amount if some future path forgets to initialise a field.
        *node = OrderNode {
            amount: 0,
            trader: Pubkey::default(),
            seq: 0,
            next: free_head,
            prev: NIL,
            price_tick: 0,
            side: 0,
            flags: 0,
            _pad: [0; 4],
        };
        self.header.free_head = idx;
        Ok(())
    }

    fn node(&self, idx: u32) -> BookResult<OrderNode> {
        self.blocks
            .get(idx as usize)
            .copied()
            .ok_or(BookError::InvalidIndex)
    }

    fn node_mut(&mut self, idx: u32) -> BookResult<&mut OrderNode> {
        self.blocks
            .get_mut(idx as usize)
            .ok_or(BookError::InvalidIndex)
    }

    fn head(&self, side: u8) -> u32 {
        if side == SIDE_BID {
            self.header.bids_head
        } else {
            self.header.asks_head
        }
    }

    fn set_head(&mut self, side: u8, idx: u32) {
        if side == SIDE_BID {
            self.header.bids_head = idx;
        } else {
            self.header.asks_head = idx;
        }
    }

    /// True if `new` outranks the resting order `at` — i.e. `new` belongs
    /// strictly before it. Price first, then seq.
    ///
    /// Note the seq comparison is **structurally unreachable on the insert
    /// path**: `insert` assigns `seq = next_seq++`, so a new order always has a
    /// strictly higher seq than anything resting, and this branch is always
    /// false at equal price — which is exactly why new orders land at the back
    /// of their price level. Mutating `<` to `<=` changes nothing and no test
    /// notices; mutating it to `>` inverts FIFO and three tests fail.
    ///
    /// It is kept, and kept in this direction, because the comparison is the
    /// ordering *definition* the invariant checker re-derives from, and because
    /// any future path that reinserts an existing order (a price-improving
    /// amend, or a tree rebuild) would supply an out-of-order seq and needs it
    /// to be right.
    fn outranks(side: u8, new_tick: u16, new_seq: u64, at: &OrderNode) -> bool {
        if new_tick != at.price_tick {
            return if side == SIDE_BID {
                new_tick > at.price_tick // higher bid is better
            } else {
                new_tick < at.price_tick // lower ask is better
            };
        }
        new_seq < at.seq
    }

    /// Insert an order, preserving price-time priority. Returns its block index.
    pub fn insert(
        &mut self,
        side: u8,
        price_tick: u16,
        amount: u64,
        trader: Pubkey,
    ) -> BookResult<u32> {
        if side != SIDE_BID && side != SIDE_ASK {
            return Err(BookError::InvalidSide);
        }
        let seq = self.header.next_seq;
        let idx = self.alloc_block()?;
        self.header.next_seq = seq.saturating_add(1);

        *self.node_mut(idx)? = OrderNode {
            amount,
            trader,
            seq,
            next: NIL,
            prev: NIL,
            price_tick,
            side,
            flags: 0,
            _pad: [0; 4],
        };

        // Walk to the first resting order this one outranks, and splice in
        // before it.
        let mut cursor = self.head(side);
        let mut prev = NIL;
        while cursor != NIL {
            let node = self.node(cursor)?;
            if Self::outranks(side, price_tick, seq, &node) {
                break;
            }
            prev = cursor;
            cursor = node.next;
        }

        self.node_mut(idx)?.prev = prev;
        self.node_mut(idx)?.next = cursor;
        if cursor != NIL {
            self.node_mut(cursor)?.prev = idx;
        }
        if prev == NIL {
            self.set_head(side, idx);
        } else {
            self.node_mut(prev)?.next = idx;
        }

        self.header.order_count += 1;
        Ok(idx)
    }

    /// Unlink and free an order.
    pub fn remove(&mut self, idx: u32) -> BookResult<()> {
        let node = self.node(idx)?;
        if node.amount == 0 && node.trader == Pubkey::default() {
            // Already free — refuse rather than corrupt the free list by
            // pushing the same block twice.
            return Err(BookError::NotFound);
        }
        let (prev, next, side) = (node.prev, node.next, node.side);

        if prev == NIL {
            self.set_head(side, next);
        } else {
            self.node_mut(prev)?.next = next;
        }
        if next != NIL {
            self.node_mut(next)?.prev = prev;
        }

        self.free(idx)?;
        self.header.order_count -= 1;
        Ok(())
    }

    /// Best resting order on a side, or `None`.
    pub fn best(&self, side: u8) -> Option<(u32, OrderNode)> {
        let head = self.head(side);
        if head == NIL {
            return None;
        }
        self.node(head).ok().map(|n| (head, n))
    }

    /// Side list from best to worst.
    pub fn iter_side(&self, side: u8) -> Vec<(u32, OrderNode)> {
        let mut out = Vec::new();
        let mut cursor = self.head(side);
        while cursor != NIL {
            let Ok(node) = self.node(cursor) else { break };
            out.push((cursor, node));
            cursor = node.next;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytemuck::Zeroable;

    struct Fixture {
        header: BookHeader,
        blocks: Vec<OrderNode>,
    }

    impl Fixture {
        fn new(capacity: usize) -> Self {
            Self {
                header: BookHeader {
                    market: Pubkey::default(),
                    next_seq: 0,
                    free_head: NIL,
                    bids_head: NIL,
                    asks_head: NIL,
                    block_count: 0,
                    order_count: 0,
                    seats_head: NIL,
                    bump: 0,
                    _pad: [0; 7],
                    _reserved: [0; 56],
                },
                blocks: vec![OrderNode::zeroed(); capacity],
            }
        }
        fn book(&mut self) -> Book<'_> {
            Book {
                header: &mut self.header,
                blocks: &mut self.blocks,
            }
        }
    }

    fn trader(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    #[test]
    fn block_is_exactly_one_cache_friendly_unit() {
        // The whole arena depends on blocks being uniform and self-aligning.
        assert_eq!(core::mem::size_of::<OrderNode>(), BLOCK_SIZE);
        assert_eq!(core::mem::size_of::<OrderNode>() % 8, 0);
        // The load-bearing one: Solana account data is 8-byte aligned, so a
        // block must never need more. A u128 field would silently make this 16
        // and break the zero-copy cast on-chain while passing on the host.
        assert_eq!(core::mem::align_of::<OrderNode>(), 8);
        assert_eq!(core::mem::align_of::<BookHeader>(), 8);
    }

    #[test]
    fn bids_sort_high_to_low_and_asks_low_to_high() {
        let mut f = Fixture::new(16);
        let mut b = f.book();
        for tick in [500u16, 700, 300, 600] {
            b.insert(SIDE_BID, tick, 1, trader(1)).unwrap();
            b.insert(SIDE_ASK, tick, 1, trader(2)).unwrap();
        }
        let bids: Vec<u16> = b.iter_side(SIDE_BID).iter().map(|(_, n)| n.price_tick).collect();
        let asks: Vec<u16> = b.iter_side(SIDE_ASK).iter().map(|(_, n)| n.price_tick).collect();
        assert_eq!(bids, vec![700, 600, 500, 300], "best bid is the highest");
        assert_eq!(asks, vec![300, 500, 600, 700], "best ask is the lowest");
    }

    #[test]
    fn equal_prices_keep_arrival_order_on_both_sides() {
        // The FIFO guarantee. Today it falls out of appending to a Vec; here it
        // is explicit logic, so it is worth stating on its own.
        let mut f = Fixture::new(16);
        let mut b = f.book();
        for i in 0..4u8 {
            b.insert(SIDE_BID, 500, 1, trader(i)).unwrap();
            b.insert(SIDE_ASK, 500, 1, trader(100 + i)).unwrap();
        }
        for side in [SIDE_BID, SIDE_ASK] {
            let seqs: Vec<u64> = b.iter_side(side).iter().map(|(_, n)| n.seq).collect();
            let mut sorted = seqs.clone();
            sorted.sort_unstable();
            assert_eq!(seqs, sorted, "equal-price orders must stay FIFO");
        }
    }

    #[test]
    fn a_better_price_jumps_the_queue_but_an_equal_one_does_not() {
        let mut f = Fixture::new(16);
        let mut b = f.book();
        let first = b.insert(SIDE_BID, 500, 1, trader(1)).unwrap();
        let equal = b.insert(SIDE_BID, 500, 1, trader(2)).unwrap();
        let better = b.insert(SIDE_BID, 501, 1, trader(3)).unwrap();

        let order: Vec<u32> = b.iter_side(SIDE_BID).iter().map(|(i, _)| *i).collect();
        assert_eq!(order, vec![better, first, equal]);
        assert_eq!(b.best(SIDE_BID).unwrap().0, better);
    }

    #[test]
    fn removing_the_head_middle_and_tail_all_keep_the_list_intact() {
        let mut f = Fixture::new(16);
        let mut b = f.book();
        let ids: Vec<u32> = (0..5u8)
            .map(|i| b.insert(SIDE_BID, 500 + i as u16, 1, trader(i)).unwrap())
            .collect();
        // Sorted desc: 504, 503, 502, 501, 500 -> ids[4], ids[3], ids[2], ids[1], ids[0]
        b.remove(ids[4]).unwrap(); // head
        b.remove(ids[2]).unwrap(); // middle
        b.remove(ids[0]).unwrap(); // tail
        let ticks: Vec<u16> = b.iter_side(SIDE_BID).iter().map(|(_, n)| n.price_tick).collect();
        assert_eq!(ticks, vec![503, 501]);
        assert_eq!(b.header.order_count, 2);
    }

    #[test]
    fn freed_blocks_are_reused_before_the_arena_grows() {
        let mut f = Fixture::new(16);
        let mut b = f.book();
        let a = b.insert(SIDE_BID, 500, 1, trader(1)).unwrap();
        let c = b.insert(SIDE_BID, 501, 1, trader(2)).unwrap();
        assert_eq!(b.header.block_count, 2);

        b.remove(a).unwrap();
        b.remove(c).unwrap();
        assert_eq!(b.header.block_count, 2, "high-water mark does not shrink");

        b.insert(SIDE_BID, 502, 1, trader(3)).unwrap();
        b.insert(SIDE_BID, 503, 1, trader(4)).unwrap();
        assert_eq!(
            b.header.block_count, 2,
            "both inserts must come off the free list, not extend the arena"
        );
    }

    #[test]
    fn removing_a_freed_block_is_rejected_rather_than_corrupting_the_free_list() {
        // Double-free would splice the same block into the free list twice and
        // hand it out to two orders at once.
        let mut f = Fixture::new(8);
        let mut b = f.book();
        let a = b.insert(SIDE_BID, 500, 1, trader(1)).unwrap();
        b.remove(a).unwrap();
        assert_eq!(b.remove(a), Err(BookError::NotFound));
    }

    #[test]
    fn the_arena_reports_full_rather_than_overrunning() {
        let mut f = Fixture::new(3);
        let mut b = f.book();
        for i in 0..3u8 {
            b.insert(SIDE_BID, 500, 1, trader(i)).unwrap();
        }
        assert_eq!(b.insert(SIDE_BID, 500, 1, trader(9)), Err(BookError::Full));
    }

    /// Deterministic LCG — a seeded generator rather than a random one, so a
    /// failure is reproducible from the seed alone.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 33
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    /// Re-derive every invariant from scratch. Cheap enough to run after each
    /// individual operation, which is what makes a failure pinpointable.
    fn check_invariants(b: &Book, live: usize) {
        let mut seen = std::collections::HashSet::new();
        let mut total = 0usize;

        for side in [SIDE_BID, SIDE_ASK] {
            let items = b.iter_side(side);
            total += items.len();
            for (idx, node) in &items {
                assert!(seen.insert(*idx), "block {idx} appears twice in the book");
                assert_eq!(node.side, side, "block {idx} is threaded on the wrong side");
            }
            // Price-time ordering.
            for w in items.windows(2) {
                let (a, bn) = (&w[0].1, &w[1].1);
                let ordered = if side == SIDE_BID {
                    a.price_tick > bn.price_tick
                        || (a.price_tick == bn.price_tick && a.seq < bn.seq)
                } else {
                    a.price_tick < bn.price_tick
                        || (a.price_tick == bn.price_tick && a.seq < bn.seq)
                };
                assert!(ordered, "price-time priority violated on side {side}");
            }
            // Back-links must mirror forward links exactly.
            for (i, (idx, node)) in items.iter().enumerate() {
                let expected_prev = if i == 0 { NIL } else { items[i - 1].0 };
                assert_eq!(node.prev, expected_prev, "prev link broken at block {idx}");
            }
        }

        assert_eq!(total, live, "order_count drifted from the actual list length");
        assert_eq!(b.header.order_count as usize, live);

        // The free list must be disjoint from the book and acyclic.
        let mut cursor = b.header.free_head;
        let mut free_len = 0usize;
        while cursor != NIL {
            assert!(
                seen.insert(cursor),
                "block {cursor} is on the free list AND in the book"
            );
            free_len += 1;
            assert!(free_len <= b.header.block_count as usize, "free list is cyclic");
            cursor = b.blocks[cursor as usize].next;
        }

        assert_eq!(
            live + free_len,
            b.header.block_count as usize,
            "blocks leaked: {live} live + {free_len} free != {} allocated",
            b.header.block_count
        );
    }

    #[test]
    fn insert_remove_preserves_price_time() {
        // The load-bearing test for the FIFO guarantee. Random interleavings of
        // insert and remove, with every invariant re-derived after each step.
        const CAPACITY: usize = 64;
        let mut f = Fixture::new(CAPACITY);
        let mut b = f.book();
        let mut rng = Lcg(0x5EED);
        let mut live: Vec<u32> = Vec::new();

        for step in 0..4000 {
            let insert = live.is_empty() || (live.len() < CAPACITY && rng.below(100) < 60);
            if insert {
                let side = if rng.below(2) == 0 { SIDE_BID } else { SIDE_ASK };
                // A narrow price band on purpose: it forces frequent ties,
                // which is exactly where time priority is tested.
                let tick = 495 + rng.below(11) as u16;
                match b.insert(side, tick, 1 + rng.below(1000), trader(rng.below(8) as u8)) {
                    Ok(idx) => live.push(idx),
                    Err(BookError::Full) => {}
                    Err(e) => panic!("unexpected insert error at step {step}: {e:?}"),
                }
            } else {
                let pick = rng.below(live.len() as u64) as usize;
                let idx = live.swap_remove(pick);
                b.remove(idx).unwrap();
            }
            check_invariants(&b, live.len());
        }

        // The run must actually have exercised both growth and reuse.
        assert!(b.header.block_count > 8, "test did not stress the arena");
        assert!(b.header.next_seq > 1000, "test did not do enough inserts");
    }

    #[test]
    fn arena_footprint_matches_the_design_budget() {
        // Pins the rent claim in docs/design/orderbook-redesign.md. Solana rent
        // is (128 + bytes) * 6960 lamports, so ONE account of N blocks is
        // dramatically cheaper than N accounts — the whole reason for this
        // rewrite.
        let header = core::mem::size_of::<BookHeader>();
        let full = 8 + header + BLOCK_SIZE * MAX_ORDERS as usize;
        assert_eq!(BLOCK_SIZE, 64);
        assert!(
            full < 22_000,
            "a fully-extended 256-order book should be ~20 KB, got {full}"
        );

        // Rent, in lamports, for the fully-extended book vs today's thin book
        // of 19 separate accounts totalling 2,640 payload bytes.
        let rent = |bytes: usize| (128 + bytes) as u64 * 6960;
        let new_full = rent(full);
        let old_thin = 19 * 128 * 6960 + 2_640 * 6960;
        assert!(
            new_full > old_thin,
            "sanity: a FULL 256-order book should cost more than a 10-order one"
        );

        // The comparison that actually matters: same 10 orders, one account.
        let new_thin = rent(8 + header + BLOCK_SIZE * 10);
        assert!(
            new_thin * 2 < old_thin,
            "10 orders in one account should be <half the 19-account cost: \
             {new_thin} vs {old_thin}"
        );
    }

    #[test]
    fn a_full_drain_returns_every_block_to_the_free_list() {
        let mut f = Fixture::new(32);
        let mut b = f.book();
        let ids: Vec<u32> = (0..20u8)
            .map(|i| {
                let side = if i % 2 == 0 { SIDE_BID } else { SIDE_ASK };
                b.insert(side, 400 + i as u16, 1, trader(i)).unwrap()
            })
            .collect();
        for idx in ids {
            b.remove(idx).unwrap();
        }
        assert_eq!(b.header.order_count, 0);
        assert_eq!(b.header.bids_head, NIL);
        assert_eq!(b.header.asks_head, NIL);
        check_invariants(&b, 0);

        // And the arena is fully reusable afterwards.
        for i in 0..20u8 {
            b.insert(SIDE_BID, 500, 1, trader(i)).unwrap();
        }
        assert_eq!(b.header.block_count, 20, "should have reused every block");
    }
}
