//! Matching: walk the opposite side, settle each fill, rest the remainder.
//!
//! This is the loop whose cost the entire redesign is justified by. Today a
//! fill needs **3 accounts and 99 transaction bytes** — `[book_side,
//! maker_position, maker_usdc_ata]` — which caps a crossing buy at 5 fills
//! against the 1232-byte packet limit.
//!
//! Here a fill touches nothing outside the book account the instruction already
//! holds: the maker's order, the maker's seat and the taker's seat are all
//! blocks in the same arena. **Zero accounts and zero bytes per fill**, so the
//! ceiling is set by compute alone.
//!
//! Token movement is deliberately absent. Fills credit `SeatNode::credit`; a
//! separate `withdraw` turns credit into USDC. That is Phoenix's seat model, and
//! it is what removes the per-fill SPL transfer — one CPI per *transaction*
//! instead of one per *fill*.

use anchor_lang::prelude::Pubkey;

use super::arena::{as_seat_mut, Book, BookError, OrderNode, KIND_SEAT, NIL, SIDE_ASK, SIDE_BID};
use super::settlement::{leg_costs, settle_leg, taker_fee, SettleError};

#[derive(Debug, PartialEq, Eq)]
pub enum MatchError {
    Book(BookError),
    Settle(SettleError),
    NoSeat,
    OrderNotFound,
    NotOwner,
}

impl From<BookError> for MatchError {
    fn from(e: BookError) -> Self {
        MatchError::Book(e)
    }
}
impl From<SettleError> for MatchError {
    fn from(e: SettleError) -> Self {
        MatchError::Settle(e)
    }
}

type R<T> = core::result::Result<T, MatchError>;

/// One executed fill, for the event log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FilledOrder {
    pub maker: Pubkey,
    pub maker_seq: u64,
    /// The MAKER's tick — the execution price.
    pub price_tick: u16,
    pub amount: u64,
}

/// Outcome of one `place`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MatchResult {
    /// Shares filled against resting orders.
    pub filled: u64,
    /// Shares left over, resting as a new order (0 if fully filled or the
    /// remainder was not posted).
    pub resting: u64,
    /// Collateral the taker must transfer in for this transaction, base units.
    pub taker_collateral_in: u64,
    /// Collateral released to the taker because fills closed existing exposure.
    pub taker_collateral_out: u64,
    /// Protocol fee owed by the taker, base units.
    pub fee: u64,
    /// Number of distinct fills — the number the CU budget is measured against.
    pub fills: u32,
    /// Sequence assigned to the resting remainder, meaningful when
    /// `resting > 0`.
    pub resting_seq: u64,
    /// Per-fill records for the event log, in execution order.
    ///
    /// A `Vec` allocates, which the arena deliberately avoids — but the 256 KB
    /// heap frame is mandatory program-wide anyway until the legacy borsh book
    /// is deleted, so this costs nothing that is not already paid. When that
    /// frame goes, this becomes a fixed-size array and `match_limit` gains a
    /// ceiling to match.
    pub filled_orders: Vec<FilledOrder>,
}

impl<'a> Book<'a> {
    /// Find a trader's seat, or create one. O(n) over seats.
    ///
    /// A linear walk is the honest cost of keeping seats in the arena, and it
    /// is the thing to watch if this ever gets slow: a per-fill maker lookup is
    /// the only super-constant work in the match loop. At the 256-order cap the
    /// walk is bounded, and it buys the elimination of a per-fill account.
    pub fn seat_mut(&mut self, trader: Pubkey) -> R<u32> {
        let mut cursor = self.header.seats_head;
        while cursor != NIL {
            let node = self.blocks.get(cursor as usize).ok_or(BookError::InvalidIndex)?;
            let seat = bytemuck::cast_ref::<OrderNode, super::arena::SeatNode>(node);
            if seat.trader == trader {
                return Ok(cursor);
            }
            cursor = seat.next;
        }
        // Allocate a new seat from the same free list orders use.
        let idx = self.alloc_block()?;
        let head = self.header.seats_head;
        let node = self.blocks.get_mut(idx as usize).ok_or(BookError::InvalidIndex)?;
        let seat = as_seat_mut(node);
        seat.credit = 0;
        seat.trader = trader;
        seat.net = 0;
        seat.next = head;
        seat._pad0 = [0; 7];
        seat.kind = KIND_SEAT;
        seat._pad1 = [0; 4];
        self.header.seats_head = idx;
        Ok(idx)
    }

    fn seat_net(&self, idx: u32) -> R<i64> {
        let node = self.blocks.get(idx as usize).ok_or(BookError::InvalidIndex)?;
        Ok(bytemuck::cast_ref::<OrderNode, super::arena::SeatNode>(node).net)
    }

    fn apply_to_seat(&mut self, idx: u32, net: i64, credit_delta: u64) -> R<()> {
        let node = self.blocks.get_mut(idx as usize).ok_or(BookError::InvalidIndex)?;
        let seat = as_seat_mut(node);
        seat.net = net;
        seat.credit = seat.credit.saturating_add(credit_delta);
        Ok(())
    }

    /// True if a resting order at `resting_tick` crosses a taker limit.
    ///
    /// On the unified axis this is an ordinary limit comparison, not the
    /// two-sided `taker_tick + maker_tick >= NUM_TICKS` rule: a taker buying
    /// YES crosses any ask at or below their limit.
    fn crosses(taker_side: u8, taker_tick: u16, resting_tick: u16) -> bool {
        if taker_side == SIDE_BID {
            resting_tick <= taker_tick
        } else {
            resting_tick >= taker_tick
        }
    }

    /// Place an order: match against the opposite side, then rest the
    /// remainder.
    ///
    /// Fills execute at the **maker's** price, which is what delivers the
    /// crossing surplus to the taker as ordinary price improvement — the
    /// "excess goes to whoever fills" rule, with no rebate accumulator.
    pub fn place(
        &mut self,
        taker: Pubkey,
        side: u8,
        limit_tick: u16,
        amount: u64,
        fee_bps: u16,
        match_limit: u32,
        post_remainder: bool,
    ) -> R<MatchResult> {
        if side != SIDE_BID && side != SIDE_ASK {
            return Err(MatchError::Book(BookError::InvalidSide));
        }
        let opposite = side ^ 1;
        let taker_seat = self.seat_mut(taker)?;

        let mut out = MatchResult::default();
        let mut remaining = amount;

        while remaining > 0 && out.fills < match_limit {
            let Some((idx, resting)) = self.best(opposite) else {
                break;
            };
            if !Self::crosses(side, limit_tick, resting.price_tick) {
                break;
            }
            // A taker crossing their own resting order would settle both legs
            // against one seat and double-count the position. Stop rather than
            // silently self-trade.
            if resting.trader == taker {
                break;
            }

            let fill = remaining.min(resting.amount);
            let exec_tick = resting.price_tick;

            let (bid_cost, ask_cost) = leg_costs(exec_tick, fill, side)?;
            let (taker_cost, maker_cost) = if side == SIDE_BID {
                (bid_cost, ask_cost)
            } else {
                (ask_cost, bid_cost)
            };

            let maker_seat = self.seat_mut(resting.trader)?;
            let maker_net = self.seat_net(maker_seat)?;
            let taker_net = self.seat_net(taker_seat)?;

            let maker_leg = settle_leg(opposite, maker_net, fill, maker_cost)?;
            let taker_leg = settle_leg(side, taker_net, fill, taker_cost)?;

            // The maker's collateral was already escrowed when they posted, so
            // a fill only moves their position and releases whatever the fill
            // closed.
            self.apply_to_seat(maker_seat, maker_leg.new_net, maker_leg.collateral_out)?;
            self.apply_to_seat(taker_seat, taker_leg.new_net, 0)?;

            out.taker_collateral_in = out
                .taker_collateral_in
                .saturating_add(taker_leg.collateral_in);
            out.taker_collateral_out = out
                .taker_collateral_out
                .saturating_add(taker_leg.collateral_out);
            out.fee = out
                .fee
                .saturating_add(taker_fee(fill, exec_tick, fee_bps, taker_cost)?);

            // Consume the resting order.
            if fill == resting.amount {
                self.remove(idx)?;
            } else {
                let node = self.blocks.get_mut(idx as usize).ok_or(BookError::InvalidIndex)?;
                node.amount -= fill;
            }

            out.filled_orders.push(FilledOrder {
                maker: resting.trader,
                maker_seq: resting.seq,
                price_tick: exec_tick,
                amount: fill,
            });

            remaining -= fill;
            out.filled += fill;
            out.fills += 1;
        }

        if remaining > 0 && post_remainder {
            let idx = self.insert(side, limit_tick, remaining, taker)?;
            out.resting = remaining;
            out.resting_seq = self
                .blocks
                .get(idx as usize)
                .ok_or(BookError::InvalidIndex)?
                .seq;
            // Resting collateral is escrowed up front, at the taker's own limit.
            let (bid_cost, ask_cost) = leg_costs(limit_tick, remaining, side)?;
            let own = if side == SIDE_BID { bid_cost } else { ask_cost };
            out.taker_collateral_in = out.taker_collateral_in.saturating_add(own);
        }

        Ok(out)
    }
}

impl<'a> Book<'a> {
    /// Collateral a resting order has escrowed: its own leg at its own limit.
    ///
    /// Recomputed from the order rather than stored. The three inputs — side,
    /// tick, remaining amount — are all in the node, and `leg_costs` is
    /// deterministic, so a stored copy could only ever disagree with reality.
    /// A partially filled order escrows for what is *left*, which is exactly
    /// what `amount` holds.
    pub fn escrow_of(&self, node: &OrderNode) -> R<u64> {
        let (bid, ask) = leg_costs(node.price_tick, node.amount, node.side)?;
        Ok(if node.side == SIDE_BID { bid } else { ask })
    }

    /// Cancel a resting order by sequence number, refunding its escrow to the
    /// owner's seat credit.
    ///
    /// Returns the refunded amount. Refusing to cancel someone else's order is
    /// the whole security boundary here, so ownership is checked before the
    /// order is touched.
    pub fn cancel(&mut self, trader: Pubkey, seq: u64) -> R<u64> {
        for side in [SIDE_BID, SIDE_ASK] {
            let mut cursor = self.head_of(side);
            while cursor != NIL {
                let node = *self.blocks.get(cursor as usize).ok_or(BookError::InvalidIndex)?;
                if node.seq == seq {
                    if node.trader != trader {
                        return Err(MatchError::NotOwner);
                    }
                    let refund = self.escrow_of(&node)?;
                    let seat = self.seat_mut(trader)?;
                    let net = self.seat_net(seat)?;
                    self.apply_to_seat(seat, net, refund)?;
                    self.remove(cursor)?;
                    return Ok(refund);
                }
                cursor = node.next;
            }
        }
        Err(MatchError::OrderNotFound)
    }

    /// Drain a trader's withdrawable credit, returning the amount.
    pub fn take_credit(&mut self, trader: Pubkey) -> R<u64> {
        let idx = self.seat_mut(trader)?;
        let node = self.blocks.get_mut(idx as usize).ok_or(BookError::InvalidIndex)?;
        let seat = as_seat_mut(node);
        let amount = seat.credit;
        seat.credit = 0;
        Ok(amount)
    }

    /// A trader's current credit, without draining it.
    pub fn credit_of(&mut self, trader: Pubkey) -> R<u64> {
        let idx = self.seat_mut(trader)?;
        let node = self.blocks.get(idx as usize).ok_or(BookError::InvalidIndex)?;
        Ok(bytemuck::cast_ref::<OrderNode, super::arena::SeatNode>(node).credit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::book::account::{book_space, init_book, load_book};
    use crate::book::settlement::ONE_SHARE;

    const FEE_BPS: u16 = 100;

    struct Acct(Vec<u64>, usize);
    impl Acct {
        fn new(cap: usize) -> Self {
            let n = book_space(cap);
            let mut a = Acct(vec![0u64; n.div_ceil(8)], n);
            {
                let d = a.bytes();
                init_book(d, Pubkey::new_unique(), 1).unwrap();
            }
            a
        }
        fn bytes(&mut self) -> &mut [u8] {
            let n = self.1;
            &mut bytemuck::cast_slice_mut(&mut self.0)[..n]
        }
    }

    fn trader(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    #[test]
    fn a_taker_fills_at_the_makers_price_not_their_own_limit() {
        // The "excess goes to whoever fills" rule. A maker rests an ask at
        // 0.45; a taker bids up to 0.60 and must pay 0.45, keeping the 0.15.
        let mut a = Acct::new(16);
        let mut book = load_book(a.bytes()).unwrap();
        book.insert(SIDE_ASK, 450, 10 * ONE_SHARE, trader(1)).unwrap();

        let r = book
            .place(trader(2), SIDE_BID, 600, 10 * ONE_SHARE, 0, 8, false)
            .unwrap();

        assert_eq!(r.fills, 1);
        assert_eq!(r.filled, 10 * ONE_SHARE);
        // 0.45 * 10, not 0.60 * 10.
        assert_eq!(r.taker_collateral_in, 45 * ONE_SHARE / 10);
    }

    #[test]
    fn it_walks_price_levels_best_first_and_stops_at_the_limit() {
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        for (tick, who) in [(400u16, 1u8), (450, 2), (500, 3), (700, 4)] {
            book.insert(SIDE_ASK, tick, ONE_SHARE, trader(who)).unwrap();
        }
        let r = book
            .place(trader(9), SIDE_BID, 500, 10 * ONE_SHARE, 0, 16, false)
            .unwrap();
        // 400, 450, 500 cross; 700 does not.
        assert_eq!(r.fills, 3);
        assert_eq!(r.filled, 3 * ONE_SHARE);
        assert_eq!(book.best(SIDE_ASK).unwrap().1.price_tick, 700);
    }

    #[test]
    fn equal_price_makers_are_filled_in_arrival_order() {
        // FIFO, end to end through the matcher rather than just the arena.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        for who in [1u8, 2, 3] {
            book.insert(SIDE_ASK, 500, ONE_SHARE, trader(who)).unwrap();
        }
        let r = book
            .place(trader(9), SIDE_BID, 500, 2 * ONE_SHARE, 0, 16, false)
            .unwrap();
        assert_eq!(r.fills, 2);
        // The survivor must be the last one posted.
        assert_eq!(book.best(SIDE_ASK).unwrap().1.trader, trader(3));
    }

    #[test]
    fn match_limit_caps_the_walk_and_the_rest_still_posts() {
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        for who in [1u8, 2, 3, 4] {
            book.insert(SIDE_ASK, 500, ONE_SHARE, trader(who)).unwrap();
        }
        let r = book
            .place(trader(9), SIDE_BID, 500, 4 * ONE_SHARE, 0, 2, true)
            .unwrap();
        assert_eq!(r.fills, 2);
        assert_eq!(r.resting, 2 * ONE_SHARE);
        assert_eq!(book.best(SIDE_BID).unwrap().1.amount, 2 * ONE_SHARE);
    }

    #[test]
    fn a_partial_fill_leaves_the_makers_remainder_resting() {
        let mut a = Acct::new(16);
        let mut book = load_book(a.bytes()).unwrap();
        book.insert(SIDE_ASK, 500, 10 * ONE_SHARE, trader(1)).unwrap();
        let r = book
            .place(trader(2), SIDE_BID, 500, 3 * ONE_SHARE, 0, 8, false)
            .unwrap();
        assert_eq!(r.filled, 3 * ONE_SHARE);
        assert_eq!(book.best(SIDE_ASK).unwrap().1.amount, 7 * ONE_SHARE);
    }

    #[test]
    fn a_self_cross_stops_rather_than_trading_with_itself() {
        // Both legs would settle against one seat, double-counting the
        // position and inventing collateral.
        let mut a = Acct::new(16);
        let mut book = load_book(a.bytes()).unwrap();
        book.insert(SIDE_ASK, 450, ONE_SHARE, trader(1)).unwrap();
        let r = book
            .place(trader(1), SIDE_BID, 600, ONE_SHARE, 0, 8, true)
            .unwrap();
        assert_eq!(r.fills, 0, "must not self-trade");
        assert_eq!(r.resting, ONE_SHARE);
    }

    #[test]
    fn positions_end_up_mirrored_and_the_vault_is_exactly_backed() {
        // The settlement invariant, driven through the matcher.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        book.insert(SIDE_ASK, 400, 10 * ONE_SHARE, trader(1)).unwrap();

        let maker_escrow = {
            let (bid, ask) = leg_costs(400, 10 * ONE_SHARE, SIDE_BID).unwrap();
            let _ = bid;
            ask
        };
        let r = book
            .place(trader(2), SIDE_BID, 400, 10 * ONE_SHARE, 0, 8, false)
            .unwrap();

        let maker = book.seat_mut(trader(1)).unwrap();
        let taker = book.seat_mut(trader(2)).unwrap();
        assert_eq!(book.seat_net(maker).unwrap(), -(10 * ONE_SHARE as i64));
        assert_eq!(book.seat_net(taker).unwrap(), 10 * ONE_SHARE as i64);

        // Taker's payment plus the maker's escrow funds exactly 1.0 per share.
        assert_eq!(r.taker_collateral_in + maker_escrow, 10 * ONE_SHARE);
    }

    #[test]
    fn the_fee_is_charged_on_the_executed_price() {
        let mut a = Acct::new(16);
        let mut book = load_book(a.bytes()).unwrap();
        book.insert(SIDE_ASK, 200, 100 * ONE_SHARE, trader(1)).unwrap();
        // Taker's limit is 0.90 but they execute at 0.20.
        let r = book
            .place(trader(2), SIDE_BID, 900, 100 * ONE_SHARE, FEE_BPS, 8, false)
            .unwrap();
        // 1% of min(0.20, 0.80) * 100 = 1% of 20 USDC.
        assert_eq!(r.fee, 200_000);
    }

    #[test]
    fn a_seat_is_reused_across_fills_not_reallocated() {
        // Otherwise every fill would leak a block and the arena would exhaust.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        for who in [1u8, 2, 3] {
            book.insert(SIDE_ASK, 500, ONE_SHARE, trader(who)).unwrap();
        }
        let before = book.header.block_count;
        book.place(trader(9), SIDE_BID, 500, 3 * ONE_SHARE, 0, 16, false)
            .unwrap();
        // 3 maker seats + 1 taker seat added; the 3 orders were freed.
        assert_eq!(book.header.order_count, 0);
        let after = book.header.block_count;
        assert!(after - before <= 4, "seats must not be reallocated per fill");
    }

    
    #[test]
    fn own_resting_order_blocks_access_to_liquidity_behind_it() {
        // A has an ask at 485. Someone else has an ask at 490. A now wants to
        // BUY at 500 — which should cross the stranger's 490.
        //
        // `place` stops at the first self-owned order instead of stepping over
        // it, so A's own 485 sits at the top of the ask side and shields the
        // 490 behind it. A gets no fill and rests at 500 — while a resting ask
        // at 490 is right there, crossable.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        book.insert(SIDE_ASK, 485, ONE_SHARE, trader(1)).unwrap(); // A's own
        book.insert(SIDE_ASK, 490, ONE_SHARE, trader(2)).unwrap(); // someone else

        let r = book
            .place(trader(1), SIDE_BID, 500, ONE_SHARE, 0, 8, true)
            .unwrap();

        println!("fills={} resting={}", r.fills, r.resting);
        assert_eq!(r.fills, 0, "no fill against trader(2)'s crossable 490");
    }

    #[test]
    fn a_self_cross_leaves_the_book_crossed() {
        // The state a user lands in by quoting both sides: a bid ABOVE an ask,
        // both their own. Anyone may lift both legs — buy at 485, sell at 515 —
        // and bank the spread, which comes straight out of this user.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        book.place(trader(1), SIDE_BID, 515, 2 * ONE_SHARE, 0, 8, true)
            .unwrap();
        book.place(trader(1), SIDE_ASK, 485, 2 * ONE_SHARE, 0, 8, true)
            .unwrap();

        let best_bid = book.best(SIDE_BID).unwrap().1.price_tick;
        let best_ask = book.best(SIDE_ASK).unwrap().1.price_tick;
        println!("best bid {best_bid}, best ask {best_ask}");
        assert!(best_bid > best_ask, "book is crossed and stays that way");
    }

}
