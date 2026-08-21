//! Settlement for the unified-axis orderbook.
//!
//! See `docs/design/orderbook-redesign.md`. Pure arithmetic — no accounts,
//! no CPI — so every rule here is exercised by ordinary `cargo test`.
//!
//! ## The unified axis
//!
//! Every order is quoted on the **YES price**. Buying NO at `b` is submitted as
//! selling YES at `1 - b`, so the book has one price axis and two directions
//! instead of two complementary books. A position is a single signed number:
//! `net > 0` is long YES, `net < 0` is long NO.
//!
//! This is Kalshi's and Drift's model. It is economically identical to a
//! two-sided complete-set book, and it makes the "excess goes to the filler"
//! rule fall out of ordinary price improvement instead of needing a separate
//! rebate accumulator (see `docs/design/orderbook-redesign.md` §5.2).
//!
//! ## One rule replaces the mint/transfer/merge table
//!
//! For a party whose net position moves by `delta` at YES price `p`, split the
//! move into the part that **reduces** their existing exposure and the part
//! that **opens** new exposure:
//!
//! ```text
//!   collateral_in  = |delta| * (p if buying YES else 1 - p)
//!   collateral_out = closing_amount * 1.0
//! ```
//!
//! Every settlement mode is a consequence, not a case:
//!
//! | taker | maker | collateral | this is the... |
//! |-------|-------|-----------:|----------------|
//! | opening | opening | `+p` and `+(1-p)` = **+1.0** in | MINT — a complete set is created |
//! | closing | closing | **-1.0** out, less `p` and `(1-p)` back in | MERGE — a complete set is burned |
//! | opening | closing | nets to **0** | TRANSFER — shares change hands |
//!
//! The vault therefore holds exactly 1.0 per unit of open interest at all
//! times, which is the solvency invariant, established structurally rather than
//! checked after the fact.
//!
//! ## Fees
//!
//! `fee = rate * min(p, 1-p) * amount`, taker-only, on the **executed** price.
//!
//! `min(p, 1-p)` is invariant under the YES↔NO swap. That matters because
//! selling 100 YES at 0.80 and buying 100 NO at 0.20 are the same position and
//! split/merge converts between them for free: a rule charging `rate * cost`
//! would price the two routes differently and everyone would take the cheap
//! one. `min(p, 1-p)` is also the amount actually at risk — the smaller leg of
//! the bet.

use crate::book::arena::{SIDE_ASK, SIDE_BID};

/// Price grid. `p = tick / NUM_TICKS`.
pub const NUM_TICKS: u64 = 1000;
/// One share, in USDC base units. A share redeems for 1.00 USDC.
pub const ONE_SHARE: u64 = 1_000_000;
pub const BPS_DENOMINATOR: u64 = 10_000;

#[derive(Debug, PartialEq, Eq)]
pub enum SettleError {
    Overflow,
    InvalidTick,
    InvalidSide,
}

type R<T> = core::result::Result<T, SettleError>;

/// What one side of a fill owes and is owed, in WAD.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LegSettlement {
    /// Collateral this party must post for the fill, USDC base units.
    pub collateral_in: u64,
    /// Collateral released back to this party because the fill reduced their
    /// existing exposure — 1.00 USDC per share closed.
    pub collateral_out: u64,
    /// Shares that reduced an opposite-side position.
    pub closing: u64,
    /// Shares that opened new exposure.
    pub opening: u64,
    /// Position after the fill.
    pub new_net: i64,
}

impl LegSettlement {
    /// Net movement from this party's perspective: positive means they receive.
    pub fn net_receive(&self) -> i64 {
        self.collateral_out as i64 - self.collateral_in as i64
    }
}

/// Split `|delta|` into the part that reduces an existing opposite position and
/// the part that opens new exposure.
///
/// Buying while short closes; buying while flat or long opens. The crossover
/// case — a delta larger than the position it is closing — splits, which is why
/// this is arithmetic rather than a branch on sign.
pub fn split_delta(old_net: i64, delta: i64) -> (u64, u64) {
    if delta == 0 {
        return (0, 0);
    }
    let magnitude = delta.unsigned_abs();
    // Exposure available to close: only when the position is on the opposite
    // side of the trade.
    let opposite = if delta > 0 {
        if old_net < 0 {
            old_net.unsigned_abs()
        } else {
            0
        }
    } else if old_net > 0 {
        old_net.unsigned_abs()
    } else {
        0
    };
    let closing = magnitude.min(opposite);
    (closing, magnitude - closing)
}

/// Cost of both legs of a fill, in USDC base units, guaranteed to sum to
/// exactly `amount`.
///
/// Computing each leg independently as `amount * tick / NUM_TICKS` would floor
/// **twice**, so the two legs can sum to `amount - 1`: the vault would be
/// short one base unit per fill and the "1.0 per unit of open interest"
/// invariant would bleed. Instead one leg is floored and the other takes the
/// remainder, so they always close exactly.
///
/// The **taker** absorbs the remainder. They are already receiving the
/// crossing surplus as price improvement, so the sub-cent goes to the party
/// that is up on the trade rather than to the passive maker.
pub fn leg_costs(price_tick: u16, amount: u64, taker_side: u8) -> R<(u64, u64)> {
    let tick = price_tick as u64;
    if tick == 0 || tick >= NUM_TICKS {
        return Err(SettleError::InvalidTick);
    }
    if taker_side != SIDE_BID && taker_side != SIDE_ASK {
        return Err(SettleError::InvalidSide);
    }
    // Maker leg floors; taker leg takes what is left so the pair sums to
    // `amount` exactly.
    let (maker_ticks, taker_is_bid) = if taker_side == SIDE_BID {
        (NUM_TICKS - tick, true) // taker is the bid; maker is the ask side
    } else {
        (tick, false) // taker is the ask; maker is the bid side
    };
    let maker_cost = amount
        .checked_mul(maker_ticks)
        .ok_or(SettleError::Overflow)?
        / NUM_TICKS;
    let taker_cost = amount
        .checked_sub(maker_cost)
        .ok_or(SettleError::Overflow)?;
    Ok(if taker_is_bid {
        (taker_cost, maker_cost)
    } else {
        (maker_cost, taker_cost)
    })
    // Returned as (bid_cost, ask_cost).
}

/// Settle one side of a fill. `own_cost` comes from [`leg_costs`].
pub fn settle_leg(side: u8, old_net: i64, amount: u64, own_cost: u64) -> R<LegSettlement> {
    let signed = match side {
        SIDE_BID => i64::try_from(amount).map_err(|_| SettleError::Overflow)?,
        SIDE_ASK => -i64::try_from(amount).map_err(|_| SettleError::Overflow)?,
        _ => return Err(SettleError::InvalidSide),
    };
    let (closing, opening) = split_delta(old_net, signed);

    // A closed share releases the full 1.00 that was backing it — the long's
    // contribution and the short's together. Amounts are already base units
    // and a share redeems for exactly one, so the released amount is `closing`.
    let new_net = old_net.checked_add(signed).ok_or(SettleError::Overflow)?;

    Ok(LegSettlement {
        collateral_in: own_cost,
        collateral_out: closing,
        closing,
        opening,
        new_net,
    })
}

/// Taker fee in USDC base units.
///
/// The fee is `rate * min(p, 1-p) * amount` — the amount genuinely at risk, and
/// invariant under the YES↔NO swap that a free split/merge performs, so
/// complementary routes are charged identically and the fee cannot be dodged by
/// choosing a side.
///
/// ## Why there is no floor-on-sum here
///
/// The floor-on-sum rule, `floor((cost + fee) / 1e12) - floor(cost / 1e12)`,
/// exists for costs carried in **WAD**, where a cost can hold a fraction of a
/// base unit that a sub-unit fee can tip over a boundary.
///
/// This book works in base units, so a cost is always a whole number of base
/// units and there is no fraction to tip: floor-on-sum and floor-on-fee are
/// provably the same function here.
///
/// EVM fee parity is deliberately not a goal: the `min(p, 1-p)` rule replaces
/// `rate * cost` precisely because the latter is arbitrageable across the
/// complement.
///
/// Note also that dividing by `NUM_TICKS` and then by `BPS_DENOMINATOR` is
/// arithmetically identical to dividing by their product —
/// `floor(floor(x/a)/b) == floor(x/(a*b))` for positive integers — so no
/// defensive scaling is needed and none is used.
pub fn taker_fee(amount: u64, price_tick: u16, fee_bps: u16) -> R<u64> {
    let tick = price_tick as u64;
    if tick == 0 || tick >= NUM_TICKS {
        return Err(SettleError::InvalidTick);
    }
    let risk_ticks = tick.min(NUM_TICKS - tick);
    // u128 for the intermediate only. Storing a u128 would break the
    // zero-copy alignment contract; computing with one is free.
    let fee = (amount as u128)
        .checked_mul(risk_ticks as u128)
        .ok_or(SettleError::Overflow)?
        .checked_mul(fee_bps as u128)
        .ok_or(SettleError::Overflow)?
        / (NUM_TICKS as u128 * BPS_DENOMINATOR as u128);
    u64::try_from(fee).map_err(|_| SettleError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEE_BPS: u16 = 100; // 1%

    fn shares(n: u64) -> u64 {
        n * ONE_SHARE
    }

    /// Settle both sides of a fill at once, the way the matcher will.
    fn fill(
        tick: u16,
        amount: u64,
        taker_side: u8,
        bid_net: i64,
        ask_net: i64,
    ) -> (LegSettlement, LegSettlement) {
        let (bid_cost, ask_cost) = leg_costs(tick, amount, taker_side).unwrap();
        (
            settle_leg(SIDE_BID, bid_net, amount, bid_cost).unwrap(),
            settle_leg(SIDE_ASK, ask_net, amount, ask_cost).unwrap(),
        )
    }

    // ── The rule that replaces mint / transfer / merge ────────────────────

    #[test]
    fn two_openers_mint_a_complete_set_worth_exactly_one() {
        let amount = shares(10);
        let (bid, ask) = fill(600, amount, SIDE_BID, 0, 0);

        assert_eq!(bid.collateral_in, shares(6)); // 0.60 * 10
        assert_eq!(ask.collateral_in, shares(4)); // 0.40 * 10
        assert_eq!(bid.collateral_out, 0);
        assert_eq!(ask.collateral_out, 0);
        assert_eq!(
            bid.collateral_in + ask.collateral_in,
            amount,
            "YES + NO must fund exactly 1.00 per share"
        );
        assert_eq!(bid.new_net, amount as i64);
        assert_eq!(ask.new_net, -(amount as i64));
    }

    #[test]
    fn two_closers_burn_a_complete_set_and_release_exactly_one() {
        let amount = shares(10);
        let (bid, ask) = fill(600, amount, SIDE_BID, -(amount as i64), amount as i64);
        assert_eq!(bid.closing, amount);
        assert_eq!(ask.closing, amount);
        assert_eq!(
            bid.net_receive() + ask.net_receive(),
            amount as i64,
            "burning a set releases exactly 1.00 per share"
        );
    }

    #[test]
    fn one_opener_and_one_closer_is_a_pure_transfer() {
        let amount = shares(10);
        let (bid, ask) = fill(600, amount, SIDE_BID, 0, amount as i64);
        let net = (bid.collateral_in + ask.collateral_in) as i64
            - (bid.collateral_out + ask.collateral_out) as i64;
        assert_eq!(net, 0, "a transfer must leave the vault flat");
    }

    #[test]
    fn the_vault_holds_exactly_one_per_unit_of_open_interest() {
        let mut vault: i64 = 0;
        let (mut a, mut b): (i64, i64) = (0, 0);
        for (amount, tick, taker) in [
            (shares(10), 600u16, SIDE_BID),
            (shares(4), 250, SIDE_ASK),
            (shares(7), 900, SIDE_BID),
            (shares(4), 500, SIDE_ASK),
            (shares(3), 100, SIDE_BID),
        ] {
            let (bid, ask) = fill(tick, amount, taker, a, b);
            vault += (bid.collateral_in + ask.collateral_in) as i64;
            vault -= (bid.collateral_out + ask.collateral_out) as i64;
            a = bid.new_net;
            b = ask.new_net;
            assert_eq!(a, -b);
            assert_eq!(
                vault,
                a.abs(),
                "vault must equal 1.00 * open interest at every step"
            );
        }
    }

    #[test]
    fn the_two_legs_always_sum_to_the_fill_even_when_the_price_does_not_divide() {
        // The hazard base units introduce and WAD hid. Flooring each leg
        // independently gives amount-1 whenever amount*tick is not a multiple
        // of NUM_TICKS, so the vault would be short one base unit PER FILL and
        // the solvency invariant would bleed away a cent at a time.
        let mut found_uneven = false;
        for amount in 1u64..400 {
            for tick in [1u16, 7, 333, 500, 501, 997, 999] {
                for taker in [SIDE_BID, SIDE_ASK] {
                    let (bid, ask) = leg_costs(tick, amount, taker).unwrap();
                    assert_eq!(
                        bid + ask,
                        amount,
                        "legs must close exactly: amount={amount} tick={tick}"
                    );
                    let naive_bid = amount * tick as u64 / NUM_TICKS;
                    let naive_ask = amount * (NUM_TICKS - tick as u64) / NUM_TICKS;
                    if naive_bid + naive_ask != amount {
                        found_uneven = true;
                    }
                }
            }
        }
        assert!(
            found_uneven,
            "the sweep never hit a case where naive double-flooring loses a \
             unit, so it did not actually test the fix"
        );
    }

    #[test]
    fn the_taker_absorbs_the_rounding_remainder() {
        // amount * tick / NUM_TICKS leaves a remainder here; whoever is taking
        // pays it. They are getting price improvement anyway.
        let amount = 7u64; // 7 base units, tick 333 -> 2.331
        let (bid_t, ask_t) = leg_costs(333, amount, SIDE_BID).unwrap();
        let (bid_m, ask_m) = leg_costs(333, amount, SIDE_ASK).unwrap();
        assert_eq!(bid_t + ask_t, amount);
        assert_eq!(bid_m + ask_m, amount);
        assert!(
            bid_t > bid_m,
            "the bid pays more when the bid is the taker: {bid_t} vs {bid_m}"
        );
    }

    #[test]
    fn a_delta_larger_than_the_position_splits_into_close_then_open() {
        let (bid, _) = fill(600, shares(10), SIDE_BID, -(shares(4) as i64), 0);
        assert_eq!(bid.closing, shares(4));
        assert_eq!(bid.opening, shares(6));
        assert_eq!(bid.new_net, shares(6) as i64);
        assert_eq!(bid.collateral_in, shares(6));
        assert_eq!(bid.collateral_out, shares(4));
    }

    #[test]
    fn a_round_trip_at_the_same_price_is_free() {
        let amount = shares(10);
        let (open, _) = fill(370, amount, SIDE_BID, 0, 0);
        let (_, close) = fill(370, amount, SIDE_ASK, 0, amount as i64);
        assert_eq!(open.net_receive(), -close.net_receive());
    }

    #[test]
    fn ticks_outside_the_open_interval_are_rejected() {
        assert_eq!(leg_costs(0, 1, SIDE_BID), Err(SettleError::InvalidTick));
        assert_eq!(leg_costs(1000, 1, SIDE_BID), Err(SettleError::InvalidTick));
    }

    // ── Fees ───────────────────────────────────────────────────────────────

    #[test]
    fn selling_yes_high_and_buying_no_low_cost_the_same_fee() {
        // THE point of min(p, 1-p). Selling 100 YES at 0.80 and buying 100 NO
        // at 0.20 are the same position, and split/merge converts between them
        // for free. A fee charged on own cost would let the sell leg pay ZERO
        // (escrow legs are fee-exempt) while the buy leg pays 1% of $20, so
        // everyone would route through the free side.
        let amount = shares(100);
        let (_, ask) = fill(800, amount, SIDE_ASK, 0, 0);
        let sell_fee = taker_fee(amount, 800, FEE_BPS).unwrap();

        let (bid, _) = fill(200, amount, SIDE_BID, 0, 0);
        let buy_fee = taker_fee(amount, 200, FEE_BPS).unwrap();

        assert_eq!(ask.collateral_in, bid.collateral_in, "same stake: $20");
        assert_eq!(
            sell_fee, buy_fee,
            "complementary routes must cost the same or the fee is dodgeable"
        );
        assert_eq!(sell_fee, 200_000, "1% of the $20 actually at risk");
    }

    #[test]
    fn the_fee_is_symmetric_around_the_midpoint() {
        let amount = shares(50);
        for tick in [1u16, 100, 370, 499] {
            let mirror = NUM_TICKS as u16 - tick;
            assert_eq!(
                taker_fee(amount, tick, FEE_BPS).unwrap(),
                taker_fee(amount, mirror, FEE_BPS).unwrap(),
                "tick {tick} and its mirror must charge the same"
            );
        }
    }

    #[test]
    fn the_fee_is_largest_at_the_midpoint_and_vanishes_at_the_tails() {
        let amount = shares(100);
        let at = |tick: u16| taker_fee(amount, tick, FEE_BPS).unwrap();
        assert!(at(500) > at(250));
        assert!(at(250) > at(50));
        assert!(at(50) > at(5));
    }

    #[test]
    fn dividing_once_or_twice_gives_the_same_fee() {
        // Worth pinning because it is easy to assume otherwise and add
        // defensive scaling that does nothing.
        //
        // For positive integers `floor(floor(x / a) / b) == floor(x / (a * b))`,
        // so dividing by NUM_TICKS and then by BPS_DENOMINATOR is exactly the
        // same as dividing by their product. There is no precision to protect
        // here and no ordering to get wrong — verified by brute force over
        // every tick 1..999 and amounts 1..20_000.
        for amount in [1u64, 7, 999, 1_000, 123_457, ONE_SHARE, 13 * ONE_SHARE + 7] {
            for tick in [1u16, 37, 250, 500, 763, 999] {
                let charged = taker_fee(amount, tick, FEE_BPS).unwrap();
                let risk = tick.min(NUM_TICKS as u16 - tick) as u64;
                let two_step = (amount * risk / NUM_TICKS) * FEE_BPS as u64 / BPS_DENOMINATOR;
                assert_eq!(charged, two_step, "amount={amount} tick={tick}");
            }
        }
    }

    #[test]
    fn the_fee_matches_the_stated_rate_exactly() {
        for amount in [1u64, 7, 999, 1_000, 123_457, ONE_SHARE, 13 * ONE_SHARE + 7] {
            for tick in [1u16, 37, 250, 500, 763, 999] {
                let charged = taker_fee(amount, tick, FEE_BPS).unwrap();
                let risk = tick.min(NUM_TICKS as u16 - tick) as u128;
                let expected = (amount as u128 * risk * FEE_BPS as u128)
                    / (NUM_TICKS as u128 * BPS_DENOMINATOR as u128);
                assert_eq!(charged as u128, expected, "amount={amount} tick={tick}");
            }
        }
    }

    #[test]
    fn the_fee_never_rounds_up() {
        // A fee that rounds up would let a taker be charged more than the
        // stated rate, which is the one direction that is not merely dust.
        for amount in [1u64, 3, 1_001, ONE_SHARE + 1] {
            for tick in [1u16, 499, 500, 999] {
                let charged = taker_fee(amount, tick, FEE_BPS).unwrap() as u128;
                let risk = tick.min(NUM_TICKS as u16 - tick) as u128;
                let exact_num = amount as u128 * risk * FEE_BPS as u128;
                let denom = NUM_TICKS as u128 * BPS_DENOMINATOR as u128;
                assert!(charged * denom <= exact_num, "fee rounded up");
            }
        }
    }

    #[test]
    fn a_zero_rate_charges_nothing_anywhere() {
        for tick in [1u16, 500, 999] {
            assert_eq!(taker_fee(shares(10), tick, 0).unwrap(), 0);
        }
    }

    // ── split_delta ────────────────────────────────────────────────────────

    #[test]
    fn split_delta_covers_every_sign_combination() {
        assert_eq!(split_delta(0, 10), (0, 10), "open long from flat");
        assert_eq!(split_delta(0, -10), (0, 10), "open short from flat");
        assert_eq!(split_delta(-10, 10), (10, 0), "close a short exactly");
        assert_eq!(split_delta(10, -10), (10, 0), "close a long exactly");
        assert_eq!(split_delta(-4, 10), (4, 6), "flip short to long");
        assert_eq!(split_delta(4, -10), (4, 6), "flip long to short");
        assert_eq!(split_delta(10, 5), (0, 5), "add to a long");
        assert_eq!(split_delta(-10, -5), (0, 5), "add to a short");
        assert_eq!(split_delta(10, 0), (0, 0), "no-op");
    }

    #[test]
    fn the_515_485_crossing_economics() {
        // A bids 515 (buy YES @ 0.515). B asks 485 (buy NO @ 0.515).
        // B is the taker, so the fill executes at A's resting 515.
        let (bid, ask) = leg_costs(515, 2 * ONE_SHARE, SIDE_ASK).unwrap();
        println!(
            "A (bid maker) pays {} for 2 YES  -> {}/share",
            bid,
            bid as f64 / 2.0 / 1e6
        );
        println!(
            "B (ask taker) pays {} for 2 NO   -> {}/share",
            ask,
            ask as f64 / 2.0 / 1e6
        );
        println!(
            "sum = {} (must equal 2 shares x $1 = {})",
            bid + ask,
            2 * ONE_SHARE
        );
        assert_eq!(bid + ask, 2 * ONE_SHARE);
        assert_eq!(bid, 1_030_000); // A pays exactly its 0.515 limit
        assert_eq!(ask, 970_000); // B pays 0.485 — better than its 0.515 limit
    }

    #[test]
    fn a_self_match_would_have_cost_exactly_one_dollar_a_pair() {
        // If the two legs DID match each other, the fill happens at ONE tick and
        // the split sums to 100c by construction — not 51.5 + 51.5 = 103.
        let (bid, ask) = leg_costs(515, ONE_SHARE, SIDE_ASK).unwrap();
        println!(
            "buy-YES leg {}c   buy-NO leg {}c   total {}c",
            bid as f64 / 10_000.0,
            ask as f64 / 10_000.0,
            (bid + ask) as f64 / 10_000.0
        );
        assert_eq!(bid + ask, ONE_SHARE, "a pair always costs exactly 1.00");
    }

    #[test]
    fn a_crossed_book_lifted_by_someone_else_really_does_cost_3c() {
        // The DIFFERENT scenario. Two separate fills at two different ticks:
        // the quoter pays their own limit on both legs, the arbitrageur pays
        // the complement of each.
        let (mine_yes, theirs_no) = leg_costs(515, ONE_SHARE, SIDE_ASK).unwrap();
        let (theirs_yes, mine_no) = leg_costs(485, ONE_SHARE, SIDE_BID).unwrap();
        println!(
            "quoter pays {}c + {}c = {}c for a pair worth 100c",
            mine_yes as f64 / 10_000.0,
            mine_no as f64 / 10_000.0,
            (mine_yes + mine_no) as f64 / 10_000.0
        );
        println!(
            "arb    pays {}c + {}c = {}c",
            theirs_yes as f64 / 10_000.0,
            theirs_no as f64 / 10_000.0,
            (theirs_yes + theirs_no) as f64 / 10_000.0
        );
        assert_eq!(mine_yes + mine_no, 1_030_000);
        assert_eq!(theirs_yes + theirs_no, 970_000);
    }

    #[test]
    fn a_self_match_would_destroy_the_traders_money() {
        // Why the matcher refuses to trade a trader against themselves, and why
        // "just let it mint a pair" is NOT a simplification.
        //
        // A seat holds ONE signed net, not separate YES and NO balances. So
        // "holds 1 YES and 1 NO" and "holds nothing" are the same number: 0.
        //
        // Buying YES and buying NO at a crossing price is exactly minting a
        // pair — 100c for something worth 100c. In a token model that is a
        // wash. Here the pair collapses to net 0, so the trader pays 100c and
        // is left holding, by the seat's own arithmetic, nothing at all.
        let start: i64 = 0;

        // The bid leg: +1 YES for 51.5c.
        let bid = settle_leg(SIDE_BID, start, ONE_SHARE, 515_000).unwrap();
        // The ask leg, computed from the SAME starting net — which is what
        // `place` does, since it reads both nets before applying either.
        let ask = settle_leg(SIDE_ASK, start, ONE_SHARE, 485_000).unwrap();

        println!("bid leg -> new_net {}", bid.new_net);
        println!("ask leg -> new_net {}", ask.new_net);
        println!(
            "paid {}c total",
            (bid.collateral_in + ask.collateral_in) / 10_000
        );

        // Applied in sequence, the second write lands on top of the first:
        // `new_net` is absolute, not a delta.
        let after_both = ask.new_net;
        assert_eq!(
            after_both,
            -(ONE_SHARE as i64),
            "second leg overwrites the first"
        );

        // And the honest combined position — long one, short one — is zero.
        let combined = bid.new_net + ask.new_net;
        assert_eq!(
            combined, 0,
            "a minted pair is indistinguishable from nothing"
        );

        // Either way the trader paid a full dollar.
        assert_eq!(bid.collateral_in + ask.collateral_in, ONE_SHARE);
    }
}
