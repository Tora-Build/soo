//! Matching: walk the opposite side, settle each fill, rest the remainder.
//!
//! This is the loop whose per-fill cost sets the book's ceiling. A fill touches
//! nothing outside the book account the instruction already holds: the maker's
//! order, the maker's seat and the taker's seat are all blocks in the same
//! arena. **Zero accounts and zero bytes per fill**, so the ceiling is set by
//! compute alone — where a layout needing 3 accounts and 99 transaction bytes
//! per fill would cap a crossing buy at 5 against the 1232-byte packet limit.
//!
//! Token movement is deliberately absent. Fills credit `SeatNode::credit`; a
//! separate `withdraw` turns credit into USDC. That is Phoenix's seat model, and
//! it is what removes the per-fill SPL transfer — one CPI per *transaction*
//! instead of one per *fill*.

use anchor_lang::prelude::Pubkey;

use super::arena::{
    as_seat, as_seat_mut, Book, BookError, OrderNode, KIND_SEAT, NIL, SIDE_ASK, SIDE_BID,
};
use super::settlement::{leg_costs, settle_leg, taker_fee, SettleError};
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};

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
    /// Shares of the trader's OWN resting orders cancelled to make way.
    ///
    /// A seat cannot trade against itself — it holds one signed net, so the
    /// two legs would cancel to zero after a full unit had been paid. So when
    /// an incoming order crosses its owner's resting order, the RESTING one is
    /// cancelled and refunded, and the incoming order carries on.
    ///
    /// Surfaced so a caller can tell the trader which of their orders went,
    /// rather than leaving them to notice.
    pub self_trade_cancelled: u64,
    /// Sequence assigned to the resting remainder, meaningful when
    /// `resting > 0`.
    pub resting_seq: u64,
    /// Per-fill records for the event log, in execution order.
    ///
    /// A `Vec` allocates, which the arena otherwise avoids — but the 256 KB
    /// heap frame is mandatory program-wide (see `lib.rs`), so this costs
    /// nothing that is not already paid. If that frame ever goes, this becomes
    /// a fixed-size array and `match_limit` gains a ceiling to match.
    pub filled_orders: Vec<FilledOrder>,
}

impl<'a> Book<'a> {
    /// Find a trader's seat, or create one. O(n) over seats.
    ///
    /// A linear walk is the honest cost of keeping seats in the arena, and it
    /// is the thing to watch if this ever gets slow: a per-fill maker lookup is
    /// the only super-constant work in the match loop. `MAX_ORDERS` bounds the
    /// walk, and it buys the elimination of a per-fill account.
    pub fn seat_mut(&mut self, trader: Pubkey) -> R<u32> {
        let mut cursor = self.header.seats_head;
        while cursor != NIL {
            let node = self
                .blocks
                .get(cursor as usize)
                .ok_or(BookError::InvalidIndex)?;
            let seat = bytemuck::cast_ref::<OrderNode, super::arena::SeatNode>(node);
            if seat.trader == trader {
                return Ok(cursor);
            }
            cursor = seat.next;
        }
        // Allocate a new seat from the same free list orders use.
        let idx = self.alloc_block()?;
        let head = self.header.seats_head;
        let node = self
            .blocks
            .get_mut(idx as usize)
            .ok_or(BookError::InvalidIndex)?;
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
        let node = self
            .blocks
            .get(idx as usize)
            .ok_or(BookError::InvalidIndex)?;
        Ok(bytemuck::cast_ref::<OrderNode, super::arena::SeatNode>(node).net)
    }

    fn apply_to_seat(&mut self, idx: u32, net: i64, credit_delta: u64) -> R<()> {
        let node = self
            .blocks
            .get_mut(idx as usize)
            .ok_or(BookError::InvalidIndex)?;
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

        // Walk the opposite side with a cursor rather than repeatedly taking
        // the best, so a self-owned order can be STEPPED OVER. Re-taking the
        // best each iteration would let a trader's own resting order shield
        // every stranger's order behind it and end the match early.
        let mut cursor = self.head_of(opposite);

        while remaining > 0 && out.fills < match_limit && cursor != NIL {
            let resting = self.node(cursor)?;
            let idx = cursor;
            if !Self::crosses(side, limit_tick, resting.price_tick) {
                // The side list is price-ordered, so nothing further crosses.
                break;
            }
            // Self-trade prevention: CANCEL THE RESTING ORDER, keep going.
            //
            // Trading a seat against itself is not possible here — the seat
            // holds one SIGNED net, so `+n` and `-n` sum to zero and the pair
            // would collapse to nothing while a full unit had been paid for
            // it. That much is a property of the representation, not a policy
            // choice.
            //
            // What IS a policy choice is what happens instead, and the two
            // obvious alternatives are both wrong:
            //
            //   - resting the incoming order leaves the book CROSSED against
            //     its own owner, free for anyone to lift both legs;
            //   - dropping the incoming order (cancel-newest) means a trader
            //     who quoted one side cannot then quote the other at a
            //     crossing price at all: the order vanishes, the transaction
            //     succeeds, and nothing has happened.
            //
            // Cancelling the RESTING order is the one answer that is neither.
            // It is economically exact: the order had escrow posted and no
            // fill, so refunding it returns precisely what it cost. The
            // trader ends holding the order they just placed, which is what
            // placing it meant. And the book cannot end up crossed, because
            // the crossing side is gone before the remainder rests.
            //
            // Read `next` BEFORE removing: `remove` unlinks the node.
            if resting.trader == taker {
                let next = resting.next;
                let refund = self.escrow_of(&resting)?;
                self.remove(idx)?;
                let node = self
                    .blocks
                    .get_mut(taker_seat as usize)
                    .ok_or(BookError::InvalidIndex)?;
                let seat = as_seat_mut(node);
                seat.credit = seat
                    .credit
                    .checked_add(refund)
                    .ok_or(MatchError::Settle(SettleError::Overflow))?;
                out.self_trade_cancelled = out
                    .self_trade_cancelled
                    .checked_add(resting.amount)
                    .ok_or(MatchError::Settle(SettleError::Overflow))?;
                cursor = next;
                continue;
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
            out.fee = out.fee.saturating_add(taker_fee(fill, exec_tick, fee_bps)?);

            // Consume the resting order. Read `next` BEFORE removing it —
            // `remove` unlinks the node and its links stop being meaningful.
            let next = resting.next;
            if fill == resting.amount {
                self.remove(idx)?;
            } else {
                let node = self
                    .blocks
                    .get_mut(idx as usize)
                    .ok_or(BookError::InvalidIndex)?;
                node.amount -= fill;
            }
            cursor = next;

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
                let node = *self
                    .blocks
                    .get(cursor as usize)
                    .ok_or(BookError::InvalidIndex)?;
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
    ///
    /// Looks the seat up rather than creating one: a wallet with no seat has
    /// nothing to withdraw, and allocating a block to say so is what let any
    /// signer consume the arena (see [`Book::seat_of`]).
    ///
    /// Frees the seat when draining empties it, so a trader who withdraws and
    /// leaves does not hold a block forever.
    pub fn take_credit(&mut self, trader: Pubkey) -> R<u64> {
        let Some(idx) = self.seat_of(trader) else {
            return Ok(0);
        };
        let node = self
            .blocks
            .get_mut(idx as usize)
            .ok_or(BookError::InvalidIndex)?;
        let seat = as_seat_mut(node);
        let amount = seat.credit;
        seat.credit = 0;
        self.free_seat_if_empty(trader)?;
        Ok(amount)
    }

    /// Drain a trader's whole settled standing: credit plus the payout their
    /// net position earns under `winning_outcome`.
    ///
    /// A seat carries a SIGNED net — `> 0` long YES, `< 0` long NO — so the
    /// payout is just "does the winning side match the sign", and each winning
    /// share redeems for exactly one unit. Every matched share was backed by a
    /// full unit at fill time (the bid leg and the ask leg sum to 1.00), so the
    /// total paid out here can never exceed what was taken in.
    ///
    /// `OUTCOME_INVALID` splits: both sides of a matched share are worth half,
    /// which is the same rule `redeem_amm_position` applies, so the two ledgers
    /// cannot drift.
    ///
    /// Zeroes both fields before returning, so a second call pays nothing.
    /// Resting orders are deliberately untouched — their escrow is recovered
    /// with `book_cancel`, which stays available after settlement precisely so
    /// a maker is never trapped.
    pub fn take_settlement(&mut self, trader: Pubkey, winning_outcome: u8) -> R<u64> {
        // Looked up, not created — same reason as `take_credit`. Redeeming a
        // seat that does not exist owes nothing and must not cost a block.
        let Some(idx) = self.seat_of(trader) else {
            return Ok(0);
        };
        let node = self
            .blocks
            .get_mut(idx as usize)
            .ok_or(BookError::InvalidIndex)?;
        let seat = as_seat_mut(node);

        let net = seat.net;
        let magnitude = net.unsigned_abs();
        let payout = match winning_outcome {
            OUTCOME_YES => {
                if net > 0 {
                    magnitude
                } else {
                    0
                }
            }
            OUTCOME_NO => {
                if net < 0 {
                    magnitude
                } else {
                    0
                }
            }
            OUTCOME_INVALID => magnitude / 2,
            _ => return Err(MatchError::Book(BookError::InvalidSide)),
        };

        let total = seat
            .credit
            .checked_add(payout)
            .ok_or(MatchError::Settle(SettleError::Overflow))?;
        seat.credit = 0;
        seat.net = 0;
        // Both fields are now zero, so the seat carries nothing. Freeing it
        // here is what stops a settled market's arena staying full of the
        // people who traded it.
        self.free_seat_if_empty(trader)?;
        Ok(total)
    }

    /// Everything this book still owes, in USDC base units, under
    /// `winning_outcome`.
    ///
    /// Three components, and all three are enumerable because the book is ONE
    /// account — a per-user PDA ledger could not be listed, and so could not
    /// be summed at all:
    ///
    ///   - **positions**: every seat's winning side, one unit per share;
    ///   - **credit**: already-released USDC nobody has withdrawn yet;
    ///   - **escrow**: collateral behind orders still resting, which comes back
    ///     to its owner through `book_cancel`.
    ///
    /// Deliberately counts escrow at full value even after settlement. A
    /// resting order cannot fill any more — `book_place` is gated on the market
    /// being open — so its escrow is a pure refund obligation.
    pub fn total_obligations(&self, winning_outcome: u8) -> R<u64> {
        let mut total: u64 = 0;

        let mut cursor = self.header.seats_head;
        while cursor != NIL {
            let node = self
                .blocks
                .get(cursor as usize)
                .ok_or(BookError::InvalidIndex)?;
            let seat = as_seat(node);
            let magnitude = seat.net.unsigned_abs();
            let owed = match winning_outcome {
                OUTCOME_YES => {
                    if seat.net > 0 {
                        magnitude
                    } else {
                        0
                    }
                }
                OUTCOME_NO => {
                    if seat.net < 0 {
                        magnitude
                    } else {
                        0
                    }
                }
                OUTCOME_INVALID => magnitude / 2,
                _ => return Err(MatchError::Book(BookError::InvalidSide)),
            };
            total = total
                .checked_add(owed)
                .and_then(|t| t.checked_add(seat.credit))
                .ok_or(MatchError::Settle(SettleError::Overflow))?;
            cursor = seat.next;
        }

        for side in [SIDE_BID, SIDE_ASK] {
            let mut cursor = self.head_of(side);
            while cursor != NIL {
                let node = self
                    .blocks
                    .get(cursor as usize)
                    .ok_or(BookError::InvalidIndex)?;
                let escrow = self.escrow_of(node)?;
                total = total
                    .checked_add(escrow)
                    .ok_or(MatchError::Settle(SettleError::Overflow))?;
                cursor = node.next;
            }
        }

        Ok(total)
    }

    /// A trader's current credit, without draining it and without allocating
    /// a seat: a wallet that has never traded reads zero rather than costing
    /// the arena a block.
    pub fn credit_of(&self, trader: Pubkey) -> R<u64> {
        let Some(idx) = self.seat_of(trader) else {
            return Ok(0);
        };
        let node = self
            .blocks
            .get(idx as usize)
            .ok_or(BookError::InvalidIndex)?;
        Ok(as_seat(node).credit)
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
        book.insert(SIDE_ASK, 450, 10 * ONE_SHARE, trader(1))
            .unwrap();

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
        book.insert(SIDE_ASK, 500, 10 * ONE_SHARE, trader(1))
            .unwrap();
        let r = book
            .place(trader(2), SIDE_BID, 500, 3 * ONE_SHARE, 0, 8, false)
            .unwrap();
        assert_eq!(r.filled, 3 * ONE_SHARE);
        assert_eq!(book.best(SIDE_ASK).unwrap().1.amount, 7 * ONE_SHARE);
    }

    #[test]
    fn a_self_cross_is_never_traded() {
        // Settling both legs against one seat would double-count the position
        // and invent collateral, so this pairing never trades. What changed is
        // what happens INSTEAD — see the two tests below.
        let mut a = Acct::new(16);
        let mut book = load_book(a.bytes()).unwrap();
        book.insert(SIDE_ASK, 450, ONE_SHARE, trader(1)).unwrap();
        let r = book
            .place(trader(1), SIDE_BID, 600, ONE_SHARE, 0, 8, true)
            .unwrap();
        assert_eq!(r.fills, 0, "must not self-trade");
    }

    #[test]
    fn positions_end_up_mirrored_and_the_vault_is_exactly_backed() {
        // The settlement invariant, driven through the matcher.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        book.insert(SIDE_ASK, 400, 10 * ONE_SHARE, trader(1))
            .unwrap();

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
        book.insert(SIDE_ASK, 200, 100 * ONE_SHARE, trader(1))
            .unwrap();
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
        assert!(
            after - before <= 4,
            "seats must not be reallocated per fill"
        );
    }

    #[test]
    fn meeting_your_own_order_cancels_it_and_places_yours() {
        // The behaviour a trader expects from placing an order: the order they
        // placed is the one they end up with.
        //
        // A seat cannot trade against itself, so something has to give. The
        // earlier answers both failed the trader — resting the incoming order
        // left the book crossed against them, and dropping it meant the order
        // silently never appeared. Cancelling the RESTING order is exact: it
        // had escrow and no fill, so the refund returns what it cost.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        book.place(trader(1), SIDE_BID, 515, 2 * ONE_SHARE, 0, 8, true)
            .unwrap();

        let r = book
            .place(trader(1), SIDE_ASK, 485, 2 * ONE_SHARE, 0, 8, true)
            .unwrap();

        assert_eq!(r.fills, 0, "never trades against itself");
        assert_eq!(r.resting, 2 * ONE_SHARE, "the new order IS placed");
        assert_eq!(r.self_trade_cancelled, 2 * ONE_SHARE, "the old one went");

        // Exactly one order left, and it is the new one.
        assert!(
            book.best(SIDE_BID).is_none(),
            "the crossed bid was cancelled"
        );
        assert_eq!(book.best(SIDE_ASK).unwrap().1.price_tick, 485);
    }

    #[test]
    fn the_cancelled_order_is_refunded_in_full() {
        // The money property. The resting order never filled, so its escrow is
        // owed back whole — anything less would charge the trader for placing
        // a second order.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        let idx = book
            .insert(SIDE_BID, 515, 2 * ONE_SHARE, trader(1))
            .unwrap();
        let escrow = book.escrow_of(&book.node(idx).unwrap()).unwrap();
        assert!(escrow > 0);

        book.place(trader(1), SIDE_ASK, 485, 2 * ONE_SHARE, 0, 8, true)
            .unwrap();

        assert_eq!(book.credit_of(trader(1)).unwrap(), escrow);
    }

    #[test]
    fn other_traders_still_fill_first() {
        // Cancelling one's own order must not cost anyone else their fill. A
        // stranger's crossable order is taken; only the trader's own is
        // cancelled.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        book.insert(SIDE_ASK, 485, ONE_SHARE, trader(1)).unwrap(); // own
        book.insert(SIDE_ASK, 490, ONE_SHARE, trader(2)).unwrap(); // stranger

        let r = book
            .place(trader(1), SIDE_BID, 500, 2 * ONE_SHARE, 0, 8, true)
            .unwrap();

        assert_eq!(r.fills, 1);
        assert_eq!(r.filled_orders[0].maker, trader(2));
        assert_eq!(r.self_trade_cancelled, ONE_SHARE);
        // Bought 1 from the stranger; the other 1 rests.
        assert_eq!(r.filled, ONE_SHARE);
        assert_eq!(r.resting, ONE_SHARE);
    }

    #[test]
    fn an_order_that_crosses_nothing_of_its_own_is_untouched() {
        // Prevention must not fire merely because the trader has orders on the
        // book — only when one of them actually crosses.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        book.insert(SIDE_ASK, 600, ONE_SHARE, trader(1)).unwrap();
        let r = book
            .place(trader(1), SIDE_BID, 515, ONE_SHARE, 0, 8, true)
            .unwrap();
        assert_eq!(r.self_trade_cancelled, 0);
        assert_eq!(r.resting, ONE_SHARE);
        assert_eq!(book.best(SIDE_ASK).unwrap().1.price_tick, 600, "kept");
    }

    #[test]
    fn the_book_is_never_left_crossed() {
        // The invariant behind all of this. Whatever the trader does, a bid
        // above an ask is free money for anyone who lifts both — and it would
        // be paid by whoever quoted them.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        for (side, tick) in [
            (SIDE_BID, 515u16),
            (SIDE_ASK, 485),
            (SIDE_BID, 700),
            (SIDE_ASK, 300),
        ] {
            book.place(trader(1), side, tick, ONE_SHARE, 0, 8, true)
                .unwrap();
            if let (Some((_, bid)), Some((_, ask))) = (book.best(SIDE_BID), book.best(SIDE_ASK)) {
                assert!(
                    bid.price_tick < ask.price_tick,
                    "crossed: bid {} >= ask {}",
                    bid.price_tick,
                    ask.price_tick,
                );
            }
        }
    }

    #[test]
    fn stepping_over_preserves_fifo_among_everyone_else() {
        // Skipping a self-owned order must not reorder the rest. Two strangers
        // rest at the same tick either side of the trader's own order; the
        // earlier seq must still fill first.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        let first = book.insert(SIDE_ASK, 490, ONE_SHARE, trader(2)).unwrap();
        book.insert(SIDE_ASK, 490, ONE_SHARE, trader(1)).unwrap(); // own, between
        let second = book.insert(SIDE_ASK, 490, ONE_SHARE, trader(3)).unwrap();
        let first_seq = book.node(first).unwrap().seq;
        let second_seq = book.node(second).unwrap().seq;
        assert!(first_seq < second_seq);

        let r = book
            .place(trader(1), SIDE_BID, 500, 2 * ONE_SHARE, 0, 8, true)
            .unwrap();

        assert_eq!(r.fills, 2);
        assert_eq!(
            r.filled_orders
                .iter()
                .map(|f| f.maker_seq)
                .collect::<Vec<_>>(),
            vec![first_seq, second_seq],
            "time priority holds across the skipped order",
        );
    }

    #[test]
    fn a_winning_long_is_paid_one_per_share() {
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        // trader(2) buys 10 from trader(1)'s resting ask at 400.
        book.insert(SIDE_ASK, 400, 10 * ONE_SHARE, trader(1))
            .unwrap();
        book.place(trader(2), SIDE_BID, 400, 10 * ONE_SHARE, 0, 8, false)
            .unwrap();

        // YES wins: the long is paid in full, the short gets nothing.
        assert_eq!(
            book.take_settlement(trader(2), OUTCOME_YES).unwrap(),
            10 * ONE_SHARE
        );
        assert_eq!(book.take_settlement(trader(1), OUTCOME_YES).unwrap(), 0);
    }

    #[test]
    fn a_winning_short_is_paid_one_per_share() {
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        book.insert(SIDE_ASK, 400, 10 * ONE_SHARE, trader(1))
            .unwrap();
        book.place(trader(2), SIDE_BID, 400, 10 * ONE_SHARE, 0, 8, false)
            .unwrap();

        // NO wins: the seller of YES was long NO all along.
        assert_eq!(
            book.take_settlement(trader(1), OUTCOME_NO).unwrap(),
            10 * ONE_SHARE
        );
        assert_eq!(book.take_settlement(trader(2), OUTCOME_NO).unwrap(), 0);
    }

    #[test]
    fn the_two_sides_together_are_paid_exactly_what_was_backed() {
        // The invariant the vault depends on. Each matched share was backed by
        // one unit at fill time — the bid leg and the ask leg sum to 1.00 — and
        // exactly one holder is paid. Total out must equal total in, at every
        // tick and every outcome, or the vault drains or strands funds.
        for tick in [1u16, 250, 400, 515, 750, 999] {
            for outcome in [OUTCOME_YES, OUTCOME_NO, OUTCOME_INVALID] {
                let mut a = Acct::new(32);
                let mut book = load_book(a.bytes()).unwrap();
                book.insert(SIDE_ASK, tick, 10 * ONE_SHARE, trader(1))
                    .unwrap();
                book.place(trader(2), SIDE_BID, tick, 10 * ONE_SHARE, 0, 8, false)
                    .unwrap();

                let (bid_leg, ask_leg) = leg_costs(tick, 10 * ONE_SHARE, SIDE_BID).unwrap();
                let backed = bid_leg + ask_leg;

                let paid = book.take_settlement(trader(1), outcome).unwrap()
                    + book.take_settlement(trader(2), outcome).unwrap();

                assert_eq!(
                    paid, backed,
                    "tick {tick} outcome {outcome}: paid {paid}, backed {backed}",
                );
            }
        }
    }

    #[test]
    fn an_invalid_outcome_splits_both_sides() {
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        book.insert(SIDE_ASK, 400, 10 * ONE_SHARE, trader(1))
            .unwrap();
        book.place(trader(2), SIDE_BID, 400, 10 * ONE_SHARE, 0, 8, false)
            .unwrap();
        assert_eq!(
            book.take_settlement(trader(1), OUTCOME_INVALID).unwrap(),
            5 * ONE_SHARE
        );
        assert_eq!(
            book.take_settlement(trader(2), OUTCOME_INVALID).unwrap(),
            5 * ONE_SHARE
        );
    }

    #[test]
    fn redeeming_twice_pays_nothing_the_second_time() {
        // The seat survives the call, so it IS callable again. Zeroing before
        // the transfer is what stops a repeat from draining the vault.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        book.insert(SIDE_ASK, 400, 10 * ONE_SHARE, trader(1))
            .unwrap();
        book.place(trader(2), SIDE_BID, 400, 10 * ONE_SHARE, 0, 8, false)
            .unwrap();
        assert_eq!(
            book.take_settlement(trader(2), OUTCOME_YES).unwrap(),
            10 * ONE_SHARE
        );
        assert_eq!(book.take_settlement(trader(2), OUTCOME_YES).unwrap(), 0);
    }

    #[test]
    fn redeeming_twice_does_not_pay_credit_again_either() {
        // Found by mutation: zeroing only `net` and leaving `credit` passed
        // every other test here, because none of them had BOTH a position and
        // credit on the same seat. A repeat call would then re-pay the credit
        // every time — an unbounded drain on the vault, not a rounding error.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();

        // Credit, from a cancelled order.
        let idx = book
            .insert(SIDE_BID, 300, 4 * ONE_SHARE, trader(1))
            .unwrap();
        let seq = book.node(idx).unwrap().seq;
        let refund = book.cancel(trader(1), seq).unwrap();
        assert!(refund > 0);

        // ...and a winning position on the same seat.
        book.insert(SIDE_ASK, 400, 10 * ONE_SHARE, trader(2))
            .unwrap();
        book.place(trader(1), SIDE_BID, 400, 10 * ONE_SHARE, 0, 8, false)
            .unwrap();

        let first = book.take_settlement(trader(1), OUTCOME_YES).unwrap();
        assert!(first > 10 * ONE_SHARE, "position AND credit both paid");
        assert_eq!(
            book.take_settlement(trader(1), OUTCOME_YES).unwrap(),
            0,
            "nothing left on a second call",
        );
    }

    #[test]
    fn settlement_pays_credit_alongside_the_position() {
        // Credit is money already released — a cancelled order's escrow, or
        // collateral freed by a fill that closed exposure. It must come out
        // with the payout, or a trader has to make a second call for it.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        let seq = book
            .insert(SIDE_BID, 400, 10 * ONE_SHARE, trader(1))
            .unwrap();
        let node_seq = book.node(seq).unwrap().seq;
        let refund = book.cancel(trader(1), node_seq).unwrap();
        assert!(refund > 0);
        // Flat position, but the refund is sitting in credit.
        assert_eq!(
            book.take_settlement(trader(1), OUTCOME_YES).unwrap(),
            refund
        );
    }

    #[test]
    fn a_trader_who_never_traded_is_paid_nothing() {
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        assert_eq!(book.take_settlement(trader(9), OUTCOME_YES).unwrap(), 0);
    }

    #[test]
    fn obligations_cover_every_matched_share() {
        // The property `reclaim_subsidy` rests on. Whatever the book owes must
        // be at least what settlement will actually pay out, or the residual is
        // overstated and the reclaim reaches into traders' collateral.
        for tick in [1u16, 250, 515, 999] {
            for outcome in [OUTCOME_YES, OUTCOME_NO, OUTCOME_INVALID] {
                let mut a = Acct::new(32);
                let mut book = load_book(a.bytes()).unwrap();
                book.insert(SIDE_ASK, tick, 10 * ONE_SHARE, trader(1))
                    .unwrap();
                book.place(trader(2), SIDE_BID, tick, 10 * ONE_SHARE, 0, 8, false)
                    .unwrap();

                let owed = book.total_obligations(outcome).unwrap();
                let paid = book.take_settlement(trader(1), outcome).unwrap()
                    + book.take_settlement(trader(2), outcome).unwrap();
                assert!(
                    owed >= paid,
                    "tick {tick} outcome {outcome}: owed {owed} < paid {paid}",
                );
            }
        }
    }

    #[test]
    fn obligations_count_resting_escrow() {
        // A resting order's escrow comes back through `book_cancel`, which
        // works after settlement. Leaving it out would let the creator reclaim
        // money a maker is still owed.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        let idx = book
            .insert(SIDE_BID, 400, 10 * ONE_SHARE, trader(1))
            .unwrap();
        let escrow = book.escrow_of(&book.node(idx).unwrap()).unwrap();
        assert!(escrow > 0);
        assert_eq!(book.total_obligations(OUTCOME_YES).unwrap(), escrow);
    }

    #[test]
    fn obligations_count_unwithdrawn_credit() {
        // Credit is money already released to a trader that they have not
        // collected. It is still owed.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        let idx = book
            .insert(SIDE_BID, 400, 10 * ONE_SHARE, trader(1))
            .unwrap();
        let seq = book.node(idx).unwrap().seq;
        let refund = book.cancel(trader(1), seq).unwrap();
        // The order is gone, so escrow is zero — but the refund is in credit.
        assert_eq!(book.total_obligations(OUTCOME_YES).unwrap(), refund);
    }

    #[test]
    fn an_empty_book_owes_nothing() {
        let mut a = Acct::new(32);
        let book = load_book(a.bytes()).unwrap();
        assert_eq!(book.total_obligations(OUTCOME_YES).unwrap(), 0);
    }

    #[test]
    fn obligations_fall_as_traders_redeem() {
        // Why `reclaim_subsidy` is callable more than once: the free residual
        // grows as obligations are settled, so a one-shot call would force the
        // creator to guess when to fire it.
        let mut a = Acct::new(32);
        let mut book = load_book(a.bytes()).unwrap();
        book.insert(SIDE_ASK, 400, 10 * ONE_SHARE, trader(1))
            .unwrap();
        book.place(trader(2), SIDE_BID, 400, 10 * ONE_SHARE, 0, 8, false)
            .unwrap();

        let before = book.total_obligations(OUTCOME_YES).unwrap();
        book.take_settlement(trader(2), OUTCOME_YES).unwrap();
        let after = book.total_obligations(OUTCOME_YES).unwrap();
        assert!(after < before, "redeeming must reduce what is owed");
    }
}
