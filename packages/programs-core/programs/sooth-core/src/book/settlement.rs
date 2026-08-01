//! Settlement for the unified-axis orderbook.
//!
//! Phase 2 of `docs/design/orderbook-redesign.md`. Pure arithmetic — no
//! accounts, no CPI — so every rule here is exercised by ordinary `cargo test`.
//!
//! ## The unified axis
//!
//! Every order is quoted on the **YES price**. Buying NO at `b` is submitted as
//! selling YES at `1 - b`, so the book has one price axis and two directions
//! instead of two complementary books. A position is a single signed number:
//! `net > 0` is long YES, `net < 0` is long NO.
//!
//! This is Kalshi's and Drift's model. It is economically identical to the
//! two-sided complete-set book we have today, and it makes the "excess goes to
//! the filler" rule fall out of ordinary price improvement instead of needing a
//! separate rebate accumulator (see `docs/design/orderbook-redesign.md` §5.2).
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
//! Today's rule is `rate * cost` on the taker's *limit* tick, and escrow (sell)
//! legs are exempt entirely. That is arbitrageable: selling 100 YES at 0.80 and
//! buying 100 NO at 0.20 are the same position, and split/merge converts
//! between them for free — but one leg pays nothing and the other pays
//! `1% * $20`. Everyone routes through the free side.
//!
//! `min(p, 1-p)` is invariant under the YES↔NO swap, which is exactly the
//! transformation split/merge makes free, so both routes cost the same. It is
//! also the amount actually at risk: the smaller leg of the bet.
//!
//! Rounding keeps the **floor-on-sum** rule from
//! `instructions/orderbook_common.rs`, which is bit-compatible with the EVM
//! deployment and pinned there by golden fixtures. Fee in base units is
//! `floor((cost + fee) / 1e12) - floor(cost / 1e12)`, never `floor(fee / 1e12)`.

use crate::book::arena::{SIDE_ASK, SIDE_BID};

/// Price grid. `p = tick / NUM_TICKS`.
pub const NUM_TICKS: u32 = 1000;
/// WAD (1e18) → USDC base units (1e6).
pub const WAD_TO_BASE: u128 = 1_000_000_000_000;
pub const BPS_DENOMINATOR: u128 = 10_000;

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
    /// Collateral this party must post for the fill.
    pub collateral_in_wad: u128,
    /// Collateral released back to this party because the fill reduced their
    /// existing exposure. `1.0` per share closed.
    pub collateral_out_wad: u128,
    /// Shares that reduced an opposite-side position.
    pub closing: u128,
    /// Shares that opened new exposure.
    pub opening: u128,
    /// Position after the fill.
    pub new_net: i128,
}

impl LegSettlement {
    /// Net movement from this party's perspective: positive means they receive.
    pub fn net_receive_wad(&self) -> i128 {
        self.collateral_out_wad as i128 - self.collateral_in_wad as i128
    }
}

/// Split `|delta|` into the part that reduces an existing opposite position and
/// the part that opens new exposure.
///
/// Buying while short closes; buying while flat or long opens. The crossover
/// case — a delta larger than the position it is closing — splits, which is why
/// this is arithmetic rather than a branch on sign.
pub fn split_delta(old_net: i128, delta: i128) -> (u128, u128) {
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

/// Price this side pays per share, in WAD. The YES buyer pays `p`; the YES
/// seller pays `1 - p` (they are acquiring NO exposure).
pub fn leg_price_wad(side: u8, price_tick: u16) -> R<u128> {
    let tick = price_tick as u32;
    if tick == 0 || tick >= NUM_TICKS {
        return Err(SettleError::InvalidTick);
    }
    let effective = match side {
        SIDE_BID => tick,
        SIDE_ASK => NUM_TICKS - tick,
        _ => return Err(SettleError::InvalidSide),
    };
    // one share = 1e18 WAD; price = effective / NUM_TICKS
    Ok((1_000_000_000_000_000_000u128 / NUM_TICKS as u128) * effective as u128)
}

/// Settle one side of a fill.
pub fn settle_leg(side: u8, old_net: i128, amount: u128, price_tick: u16) -> R<LegSettlement> {
    let signed = match side {
        SIDE_BID => i128::try_from(amount).map_err(|_| SettleError::Overflow)?,
        SIDE_ASK => -i128::try_from(amount).map_err(|_| SettleError::Overflow)?,
        _ => return Err(SettleError::InvalidSide),
    };
    let (closing, opening) = split_delta(old_net, signed);

    let unit_price = leg_price_wad(side, price_tick)?;
    let collateral_in_wad = unit_price
        .checked_mul(amount)
        .ok_or(SettleError::Overflow)?
        / 1_000_000_000_000_000_000u128;

    // A closed share releases the full 1.0 that was backing it — the long's
    // contribution and the short's together. Shares are WAD and one share
    // redeems for 1.0 USDC, so the released amount is just `closing`.
    let collateral_out_wad = closing;

    let new_net = old_net
        .checked_add(signed)
        .ok_or(SettleError::Overflow)?;

    Ok(LegSettlement {
        collateral_in_wad,
        collateral_out_wad,
        closing,
        opening,
        new_net,
    })
}

/// Taker fee in USDC base units, using the floor-on-sum rule.
///
/// `collateral_in_wad` is the taker's own collateral for the fill; the fee is
/// computed on `min(p, 1-p) * amount` and then rounded **against the sum**, so
/// the fee is the marginal base unit the taker pays on top of their cost. This
/// is the rule `instructions/orderbook_common.rs` pins with EVM golden
/// fixtures — `floor(fee / 1e12)` alone drifts.
pub fn taker_fee_base(
    amount: u128,
    price_tick: u16,
    fee_bps: u16,
    collateral_in_wad: u128,
) -> R<u64> {
    let tick = price_tick as u32;
    if tick == 0 || tick >= NUM_TICKS {
        return Err(SettleError::InvalidTick);
    }
    // min(p, 1 - p): symmetric across the YES↔NO complement, so a trade and its
    // mirror are charged identically and split/merge cannot be used to dodge.
    let risk_ticks = tick.min(NUM_TICKS - tick) as u128;
    let notional_wad = amount
        .checked_mul(risk_ticks)
        .ok_or(SettleError::Overflow)?
        / NUM_TICKS as u128;
    let fee_wad = notional_wad
        .checked_mul(fee_bps as u128)
        .ok_or(SettleError::Overflow)?
        / BPS_DENOMINATOR;

    let base = collateral_in_wad / WAD_TO_BASE;
    let base_plus_fee = collateral_in_wad
        .checked_add(fee_wad)
        .ok_or(SettleError::Overflow)?
        / WAD_TO_BASE;
    u64::try_from(base_plus_fee - base).map_err(|_| SettleError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WAD: u128 = 1_000_000_000_000_000_000;
    /// 1% — the fixture's `fee_bps`.
    const FEE_BPS: u16 = 100;

    fn shares(n: u128) -> u128 {
        n * WAD
    }

    // ── The rule that replaces mint / transfer / merge ────────────────────

    #[test]
    fn two_openers_mint_a_complete_set_worth_exactly_one() {
        // A YES buyer at 0.60 meets a NO buyer at 0.40 (an ASK at tick 600).
        // Together they must fund exactly 1.0 per share and nothing else.
        let amount = shares(10);
        let bid = settle_leg(SIDE_BID, 0, amount, 600).unwrap();
        let ask = settle_leg(SIDE_ASK, 0, amount, 600).unwrap();

        assert_eq!(bid.collateral_in_wad, shares(6)); // 0.60 * 10
        assert_eq!(ask.collateral_in_wad, shares(4)); // 0.40 * 10
        assert_eq!(bid.collateral_out_wad, 0);
        assert_eq!(ask.collateral_out_wad, 0);

        let into_vault = bid.collateral_in_wad + ask.collateral_in_wad;
        assert_eq!(into_vault, amount, "YES + NO must sum to exactly 1.0/share");

        assert_eq!(bid.new_net, amount as i128);
        assert_eq!(ask.new_net, -(amount as i128));
    }

    #[test]
    fn two_closers_burn_a_complete_set_and_release_exactly_one() {
        // The mirror. A long YES closing meets a long NO closing.
        let amount = shares(10);
        let seller = settle_leg(SIDE_ASK, amount as i128, amount, 600).unwrap();
        let buyer = settle_leg(SIDE_BID, -(amount as i128), amount, 600).unwrap();

        assert_eq!(seller.closing, amount);
        assert_eq!(buyer.closing, amount);

        // Each gets 1.0/share back and pays their leg price.
        assert_eq!(seller.net_receive_wad(), (amount - shares(4)) as i128); // +0.60/share
        assert_eq!(buyer.net_receive_wad(), (amount - shares(6)) as i128); // +0.40/share

        let out_of_vault = seller.net_receive_wad() + buyer.net_receive_wad();
        assert_eq!(out_of_vault, amount as i128, "burning releases exactly 1.0/share");
    }

    #[test]
    fn one_opener_and_one_closer_is_a_pure_transfer() {
        // Vault must not move: shares change hands, no set is created or burned.
        let amount = shares(10);
        let opener = settle_leg(SIDE_BID, 0, amount, 600).unwrap();
        let closer = settle_leg(SIDE_ASK, amount as i128, amount, 600).unwrap();

        let vault_delta = opener.collateral_in_wad as i128 - closer.net_receive_wad()
            + closer.collateral_in_wad as i128
            - opener.collateral_out_wad as i128;
        // Simpler statement of the same thing:
        let net = (opener.collateral_in_wad + closer.collateral_in_wad) as i128
            - (opener.collateral_out_wad + closer.collateral_out_wad) as i128;
        assert_eq!(net, 0, "a transfer must leave the vault flat");
        let _ = vault_delta;
    }

    #[test]
    fn the_vault_holds_exactly_one_per_unit_of_open_interest() {
        // The solvency invariant, established structurally. Walk a sequence of
        // fills and check the vault against open interest after each one.
        let mut vault: i128 = 0;
        let mut a: i128 = 0; // trader A net
        let mut b: i128 = 0; // trader B net

        let steps: [(u128, u16); 5] = [
            (shares(10), 600),
            (shares(4), 250),
            (shares(7), 900),
            (shares(4), 500),
            (shares(3), 100),
        ];
        for (amount, tick) in steps {
            let bid = settle_leg(SIDE_BID, a, amount, tick).unwrap();
            let ask = settle_leg(SIDE_ASK, b, amount, tick).unwrap();
            vault += bid.collateral_in_wad as i128 + ask.collateral_in_wad as i128;
            vault -= bid.collateral_out_wad as i128 + ask.collateral_out_wad as i128;
            a = bid.new_net;
            b = ask.new_net;

            // A and B are always mirror images here, so open interest is |a|.
            assert_eq!(a, -b);
            let open_interest = a.unsigned_abs() as i128;
            assert_eq!(
                vault, open_interest,
                "vault must equal 1.0 * open interest at every step"
            );
        }
    }

    #[test]
    fn a_delta_larger_than_the_position_splits_into_close_then_open() {
        // Flipping from long NO to long YES in one fill.
        let leg = settle_leg(SIDE_BID, -(shares(4) as i128), shares(10), 600).unwrap();
        assert_eq!(leg.closing, shares(4));
        assert_eq!(leg.opening, shares(6));
        assert_eq!(leg.new_net, shares(6) as i128);
        // Pays 0.60 on all 10, gets 1.0 back on the 4 it closed.
        assert_eq!(leg.collateral_in_wad, shares(6));
        assert_eq!(leg.collateral_out_wad, shares(4));
    }

    #[test]
    fn buying_while_already_long_opens_nothing_extra_to_close() {
        let leg = settle_leg(SIDE_BID, shares(5) as i128, shares(3), 600).unwrap();
        assert_eq!(leg.closing, 0);
        assert_eq!(leg.opening, shares(3));
        assert_eq!(leg.collateral_out_wad, 0);
    }

    #[test]
    fn a_round_trip_at_the_same_price_is_free() {
        // Open then close at the same tick must return exactly what was paid —
        // no drift, or every flat trader slowly leaks money to the vault.
        let amount = shares(10);
        let open = settle_leg(SIDE_BID, 0, amount, 370).unwrap();
        let close = settle_leg(SIDE_ASK, amount as i128, amount, 370).unwrap();
        assert_eq!(open.net_receive_wad(), -close.net_receive_wad());
    }

    // ── Prices ─────────────────────────────────────────────────────────────

    #[test]
    fn the_two_legs_of_a_price_always_sum_to_one() {
        for tick in [1u16, 250, 500, 501, 999] {
            let bid = leg_price_wad(SIDE_BID, tick).unwrap();
            let ask = leg_price_wad(SIDE_ASK, tick).unwrap();
            assert_eq!(bid + ask, WAD, "tick {tick} legs must sum to 1.0");
        }
    }

    #[test]
    fn ticks_outside_the_open_interval_are_rejected() {
        // 0 and 1000 are free and certain respectively — neither is tradeable.
        assert_eq!(leg_price_wad(SIDE_BID, 0), Err(SettleError::InvalidTick));
        assert_eq!(leg_price_wad(SIDE_BID, 1000), Err(SettleError::InvalidTick));
        assert_eq!(
            leg_price_wad(SIDE_BID, u16::MAX),
            Err(SettleError::InvalidTick)
        );
    }

    // ── Fees ───────────────────────────────────────────────────────────────

    #[test]
    fn selling_yes_high_and_buying_no_low_cost_the_same_fee() {
        // THE point of min(p, 1-p), and the arbitrage today's rule leaves open.
        //
        // Selling 100 YES at 0.80 and buying 100 NO at 0.20 are the same
        // position, and split/merge converts between them for free. Under the
        // current rule the sell leg pays ZERO (escrow legs are fee-exempt) and
        // the buy leg pays 1% of $20 — so everyone routes through the free side
        // and the fee is simply avoidable.
        let amount = shares(100);

        // Sell YES at tick 800 == acquire NO exposure at 0.20.
        let sell = settle_leg(SIDE_ASK, 0, amount, 800).unwrap();
        let sell_fee = taker_fee_base(amount, 800, FEE_BPS, sell.collateral_in_wad).unwrap();

        // Buy NO at 0.20 is submitted as sell YES at 0.80 — the same order.
        // The mirror trade is buying YES at tick 200.
        let buy = settle_leg(SIDE_BID, 0, amount, 200).unwrap();
        let buy_fee = taker_fee_base(amount, 200, FEE_BPS, buy.collateral_in_wad).unwrap();

        assert_eq!(sell.collateral_in_wad, buy.collateral_in_wad, "same stake");
        assert_eq!(
            sell_fee, buy_fee,
            "complementary routes must cost the same fee or the fee is dodgeable"
        );
        // 1% of the 20 USDC actually at risk.
        assert_eq!(sell_fee, 200_000);
    }

    #[test]
    fn the_fee_is_symmetric_around_the_midpoint() {
        // min(p, 1-p) is invariant under p -> 1-p, which is exactly the
        // transformation a free split/merge performs.
        let amount = shares(50);
        for tick in [1u16, 100, 370, 499] {
            let mirror = (NUM_TICKS as u16) - tick;
            let a = settle_leg(SIDE_BID, 0, amount, tick).unwrap();
            let b = settle_leg(SIDE_ASK, 0, amount, mirror).unwrap();
            let fa = taker_fee_base(amount, tick, FEE_BPS, a.collateral_in_wad).unwrap();
            let fb = taker_fee_base(amount, mirror, FEE_BPS, b.collateral_in_wad).unwrap();
            assert_eq!(fa, fb, "tick {tick} and its mirror must charge the same");
        }
    }

    #[test]
    fn the_fee_is_largest_at_the_midpoint_and_vanishes_at_the_tails() {
        // Charging on min(p, 1-p) means the fee tracks what is actually at
        // risk, so near-certain outcomes are cheap to trade.
        let amount = shares(100);
        let at = |tick: u16| {
            let leg = settle_leg(SIDE_BID, 0, amount, tick).unwrap();
            taker_fee_base(amount, tick, FEE_BPS, leg.collateral_in_wad).unwrap()
        };
        assert!(at(500) > at(250));
        assert!(at(250) > at(50));
        assert!(at(50) > at(5));
    }

    #[test]
    fn fees_round_on_the_sum_not_on_the_fee_alone() {
        // Carries the EVM-bit-compatible rule from orderbook_common.rs, and
        // uses a case constructed so the two rules provably disagree — a test
        // that only checks agreement would pass against either.
        //
        // At tick 500 the cost is amount/2 and the fee is amount/200. Pick the
        // amount so the cost lands one WAD-unit short of a base-unit boundary:
        // the fee is far below one base unit on its own, but it tips the sum
        // over. floor(fee / 1e12) drops it; floor-on-sum collects it.
        let amount = 1_999_999_999_998u128;
        let leg = settle_leg(SIDE_BID, 0, amount, 500).unwrap();

        let cost_wad = leg.collateral_in_wad;
        assert_eq!(cost_wad, 999_999_999_999, "one WAD-unit below a base unit");

        let risk_wad = amount * 500 / NUM_TICKS as u128;
        let fee_wad = risk_wad * FEE_BPS as u128 / BPS_DENOMINATOR;
        assert_eq!(fee_wad, 9_999_999_999);

        let on_fee = fee_wad / WAD_TO_BASE; // 0 — dropped entirely
        let on_sum = (cost_wad + fee_wad) / WAD_TO_BASE - cost_wad / WAD_TO_BASE;
        assert_eq!(on_fee, 0);
        assert_eq!(on_sum, 1);

        let charged = taker_fee_base(amount, 500, FEE_BPS, cost_wad).unwrap();
        assert_eq!(
            charged as u128, on_sum,
            "must follow floor-on-sum; floor-on-fee would silently drop this \
             fee and drift permanently from the EVM deployment"
        );
    }

    #[test]
    fn a_zero_rate_charges_nothing_anywhere() {
        for tick in [1u16, 500, 999] {
            let leg = settle_leg(SIDE_BID, 0, shares(10), tick).unwrap();
            assert_eq!(
                taker_fee_base(shares(10), tick, 0, leg.collateral_in_wad).unwrap(),
                0
            );
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
}
