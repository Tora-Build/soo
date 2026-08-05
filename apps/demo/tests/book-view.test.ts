// View models for the redesigned orderbook.
//
// Pure functions over a decoded `BookSnapshot`, so these run without a chain, a
// wallet or React — which is the point. The legacy equivalents were embedded in
// hooks and had no unit coverage at all.

import { describe, expect, it } from "vitest";
import type { BookSnapshot } from "@sooth/sdk-solana";

import {
  NUM_TICKS,
  ONE_SHARE_BASE,
  SIDE_ASK,
  SIDE_BID,
  escrowOf,
  legCosts,
  myAccount,
  myOrders,
  myPosition,
  selfCrossExposure,
  quoteSweep,
  toBookView,
  toLadder,
  toShares,
  yesPrice,
} from "../src/lib/book-view";

const ALICE = "Ai1ce11111111111111111111111111111111111111";
const BOB = "Bob11111111111111111111111111111111111111111";

let seq = 0n;
function order(trader: string, priceTick: number, shares: number, side: number) {
  return {
    index: Number(seq),
    seq: seq++,
    trader,
    priceTick,
    side,
    amount: BigInt(shares) * ONE_SHARE_BASE,
  };
}

function snapshot(partial: Partial<BookSnapshot> = {}): BookSnapshot {
  return {
    market: "Mkt1111111111111111111111111111111111111111",
    nextSeq: seq,
    orderCount: (partial.bids?.length ?? 0) + (partial.asks?.length ?? 0),
    blockCount: 8,
    capacity: 64,
    bids: [],
    asks: [],
    seats: [],
    ...partial,
  } as BookSnapshot;
}

describe("yesPrice", () => {
  it("is a plain division — no side argument, no complement flip", () => {
    // The legacy helper needed a side, and forgetting it rendered the wrong
    // side of the market at a glance-identical number. On the unified axis a
    // bid at 400 and an ask at 400 are both "YES at 0.40".
    expect(yesPrice(400)).toBeCloseTo(0.4, 10);
    expect(yesPrice(600)).toBeCloseTo(0.6, 10);
    expect(yesPrice(1)).toBeCloseTo(0.001, 10);
    expect(yesPrice(NUM_TICKS - 1)).toBeCloseTo(0.999, 10);
  });

  it("clamps rather than emitting an out-of-range price", () => {
    expect(yesPrice(5000)).toBe(1);
    expect(yesPrice(-5)).toBe(0);
  });

  it("converts base units to shares", () => {
    expect(toShares(ONE_SHARE_BASE)).toBe(1);
    expect(toShares(ONE_SHARE_BASE * 7n)).toBe(7);
    expect(toShares(500_000n)).toBe(0.5);
  });
});

describe("toLadder", () => {
  it("aggregates equal prices and keeps the given order", () => {
    // Must not re-sort: the snapshot is already best-first by the program's
    // intrusive list, and re-sorting would discard the time priority the
    // on-chain matcher actually uses.
    seq = 0n;
    const bids = [
      order(ALICE, 500, 2, SIDE_BID),
      order(BOB, 500, 3, SIDE_BID),
      order(ALICE, 400, 1, SIDE_BID),
    ];
    const rows = toLadder(bids);
    expect(rows.map((r) => r.tick)).toEqual([500, 400]);
    expect(rows[0]!.amount).toBe(5n * ONE_SHARE_BASE);
    expect(rows[0]!.orderCount).toBe(2);
    expect(rows[0]!.shares).toBe(5);
  });

  it("accumulates depth from the best price down", () => {
    seq = 0n;
    const asks = [
      order(ALICE, 400, 1, SIDE_ASK),
      order(BOB, 410, 2, SIDE_ASK),
      order(ALICE, 420, 3, SIDE_ASK),
    ];
    expect(toLadder(asks).map((r) => Number(r.cumulative / ONE_SHARE_BASE))).toEqual([
      1, 3, 6,
    ]);
  });

  it("caps rows but still folds later orders into an existing level", () => {
    seq = 0n;
    const bids = [
      order(ALICE, 500, 1, SIDE_BID),
      order(BOB, 500, 1, SIDE_BID),
      order(ALICE, 400, 1, SIDE_BID),
    ];
    const rows = toLadder(bids, 1);
    expect(rows).toHaveLength(1);
    // The second order at the same level still counts — dropping it would
    // understate visible depth at the top of book.
    expect(rows[0]!.amount).toBe(2n * ONE_SHARE_BASE);
  });

  it("returns nothing for an empty side", () => {
    expect(toLadder([])).toEqual([]);
  });
});

describe("toBookView", () => {
  it("computes mid and spread from the two best prices", () => {
    seq = 0n;
    const view = toBookView(
      snapshot({
        bids: [order(ALICE, 400, 1, SIDE_BID)],
        asks: [order(BOB, 600, 1, SIDE_ASK)],
      }),
    );
    expect(view.midPrice).toBeCloseTo(0.5, 10);
    expect(view.spread).toBeCloseTo(0.2, 10);
  });

  it("reports null mid and spread when a side is empty", () => {
    // A one-sided book has no midpoint. Returning 0 would render as a real
    // price and read as a market trading at zero.
    seq = 0n;
    const view = toBookView(snapshot({ bids: [order(ALICE, 400, 1, SIDE_BID)] }));
    expect(view.midPrice).toBeNull();
    expect(view.spread).toBeNull();
  });

  it("reports arena capacity use", () => {
    const view = toBookView(snapshot({ blockCount: 16, capacity: 64 }));
    expect(view.capacityUsed).toBeCloseTo(0.25, 10);
  });
});

describe("myOrders", () => {
  it("returns only the caller's orders, each with its real seq", () => {
    seq = 0n;
    const snap = snapshot({
      bids: [order(ALICE, 500, 1, SIDE_BID), order(BOB, 490, 1, SIDE_BID)],
      asks: [order(ALICE, 600, 2, SIDE_ASK)],
    });
    const mine = myOrders(snap, ALICE);
    expect(mine).toHaveLength(2);
    // The id IS the sequence — nothing is synthesised, so nothing has to be
    // parsed back out. The legacy path built "${side}:${tick}" strings and
    // regex-parsed them, which resolved "unknown-400" to the NO side and
    // truncated "yes-12345" to tick 345.
    expect(mine.map((o) => o.id)).toEqual(mine.map((o) => o.seq.toString()));
    expect(mine.every((o) => /^\d+$/.test(o.id))).toBe(true);
  });

  it("orders earliest-first, matching consumption order", () => {
    seq = 0n;
    const a = order(ALICE, 500, 1, SIDE_BID);
    const b = order(ALICE, 500, 1, SIDE_BID);
    const snap = snapshot({ bids: [b, a] }); // deliberately reversed
    expect(myOrders(snap, ALICE).map((o) => o.seq)).toEqual([a.seq, b.seq]);
  });

  it("returns nothing for a trader with no orders", () => {
    seq = 0n;
    expect(myOrders(snapshot({ bids: [order(BOB, 500, 1, SIDE_BID)] }), ALICE)).toEqual(
      [],
    );
  });

  it("prices both sides on the same axis", () => {
    seq = 0n;
    const snap = snapshot({
      bids: [order(ALICE, 400, 1, SIDE_BID)],
      asks: [order(ALICE, 400, 1, SIDE_ASK)],
    });
    const [bid, ask] = myOrders(snap, ALICE);
    // Same tick, same displayed price. On the legacy two-sided book these
    // would have shown 0.40 and 0.60.
    expect(bid!.price).toBeCloseTo(0.4, 10);
    expect(ask!.price).toBeCloseTo(0.4, 10);
    expect(bid!.isBid).toBe(true);
    expect(ask!.isBid).toBe(false);
  });
});

describe("myPosition", () => {
  it("reads position and credit from the seat", () => {
    const snap = snapshot({
      seats: [{ trader: ALICE, credit: 6n * ONE_SHARE_BASE, net: 10n * ONE_SHARE_BASE }],
    });
    const pos = myPosition(snap, ALICE);
    expect(pos.side).toBe("YES");
    expect(pos.netShares).toBe(10);
    expect(pos.creditUsdc).toBe(6);
  });

  it("reports a short position as NO", () => {
    const snap = snapshot({
      seats: [{ trader: ALICE, credit: 0n, net: -4n * ONE_SHARE_BASE }],
    });
    const pos = myPosition(snap, ALICE);
    expect(pos.side).toBe("NO");
    expect(pos.netShares).toBe(-4);
  });

  it("reports a trader with no seat as flat rather than missing", () => {
    // A user who has never traded must render as a real zero, not undefined.
    const pos = myPosition(snapshot(), ALICE);
    expect(pos.side).toBe("FLAT");
    expect(pos.net).toBe(0n);
    expect(pos.credit).toBe(0n);
  });
});

describe("quoteSweep", () => {
  it("prices a buy against the asks, cheapest first", () => {
    seq = 0n;
    const snap = snapshot({
      asks: [
        order(BOB, 400, 1, SIDE_ASK),
        order(BOB, 500, 1, SIDE_ASK),
        order(BOB, 600, 1, SIDE_ASK),
      ],
    });
    const q = quoteSweep(snap, SIDE_BID, 2n * ONE_SHARE_BASE);
    // 0.40 + 0.50 = 0.90 USDC for 2 shares.
    expect(q.cost).toBe(900_000n);
    expect(q.filled).toBe(2n * ONE_SHARE_BASE);
    expect(q.levels).toBe(2);
    expect(q.avgPrice).toBeCloseTo(0.45, 10);
  });

  it("prices a sell as the complement of the bids it hits", () => {
    // A seller of YES is acquiring NO exposure, so they pay (1 - p) per share.
    seq = 0n;
    const snap = snapshot({ bids: [order(BOB, 600, 1, SIDE_BID)] });
    const q = quoteSweep(snap, SIDE_ASK, ONE_SHARE_BASE);
    expect(q.cost).toBe(400_000n);
  });

  it("stops at the limit tick", () => {
    seq = 0n;
    const snap = snapshot({
      asks: [order(BOB, 400, 1, SIDE_ASK), order(BOB, 700, 1, SIDE_ASK)],
    });
    const q = quoteSweep(snap, SIDE_BID, 5n * ONE_SHARE_BASE, 500);
    expect(q.levels).toBe(1);
    expect(q.filled).toBe(ONE_SHARE_BASE);
  });

  it("reports a partial fill rather than presenting it as complete", () => {
    // A caller comparing `filled` to what they asked for learns the book is
    // too thin. Returning only a cost would show a real price for an order
    // that cannot execute.
    seq = 0n;
    const snap = snapshot({ asks: [order(BOB, 400, 1, SIDE_ASK)] });
    const q = quoteSweep(snap, SIDE_BID, 10n * ONE_SHARE_BASE);
    expect(q.filled).toBe(ONE_SHARE_BASE);
    expect(q.filled).toBeLessThan(10n * ONE_SHARE_BASE);
  });

  it("returns a null average price against an empty book", () => {
    expect(quoteSweep(snapshot(), SIDE_BID, ONE_SHARE_BASE)).toEqual({
      cost: 0n,
      filled: 0n,
      levels: 0,
      avgPrice: null,
    });
  });

  it("takes a partial bite out of a larger resting order", () => {
    seq = 0n;
    const snap = snapshot({ asks: [order(BOB, 500, 10, SIDE_ASK)] });
    const q = quoteSweep(snap, SIDE_BID, 3n * ONE_SHARE_BASE);
    expect(q.filled).toBe(3n * ONE_SHARE_BASE);
    expect(q.cost).toBe(1_500_000n);
    expect(q.levels).toBe(1);
  });
});

describe("legCosts", () => {
  // A mirror of the program's `leg_costs`. The invariant that matters is that
  // the pair sums to `amount` EXACTLY — flooring both legs lets the pair come
  // to `amount - 1`, which bleeds the vault by a base unit per fill.
  it("splits the amount at the tick", () => {
    const [bid, ask] = legCosts(400, 10n * ONE_SHARE_BASE, SIDE_BID);
    expect(bid).toBe(4n * ONE_SHARE_BASE);
    expect(ask).toBe(6n * ONE_SHARE_BASE);
  });

  it("sums to the amount exactly, at every tick and awkward size", () => {
    // 7 base units at tick 333 is where naive double-flooring loses one.
    for (const amount of [1n, 7n, 999n, 1_000_001n, 123_456_789n]) {
      for (const tick of [1, 333, 500, 667, 999]) {
        for (const side of [SIDE_BID, SIDE_ASK]) {
          const [bid, ask] = legCosts(tick, amount, side);
          expect(bid + ask).toBe(amount);
        }
      }
    }
  });

  it("gives the maker the floored leg on both sides", () => {
    // Taker takes the remainder, so rounding dust always lands with the taker,
    // never in a gap between the two.
    const [bidT, askT] = legCosts(333, 10n, SIDE_BID); // taker is the bid
    expect(askT).toBe((10n * 667n) / 1000n); // maker (ask) floors
    expect(bidT).toBe(10n - askT);

    const [bidA, askA] = legCosts(333, 10n, SIDE_ASK); // taker is the ask
    expect(bidA).toBe((10n * 333n) / 1000n); // maker (bid) floors
    expect(askA).toBe(10n - bidA);
  });

  it("rejects a tick that cannot rest", () => {
    expect(() => legCosts(0, 10n, SIDE_BID)).toThrow(RangeError);
    expect(() => legCosts(1000, 10n, SIDE_BID)).toThrow(RangeError);
  });
});

describe("escrowOf", () => {
  it("locks only the maker's own leg", () => {
    // A bid at 0.40 for 10 shares locks 4 USDC — not 10. The counterparty
    // brings the other 6. Charging the full notional would overstate what the
    // trader has committed by more than 2x at mid prices.
    expect(escrowOf({ priceTick: 400, amount: 10n * ONE_SHARE_BASE, side: SIDE_BID })).toBe(
      4n * ONE_SHARE_BASE,
    );
    expect(escrowOf({ priceTick: 400, amount: 10n * ONE_SHARE_BASE, side: SIDE_ASK })).toBe(
      6n * ONE_SHARE_BASE,
    );
  });

  it("is symmetric under the YES/NO flip", () => {
    // A bid at t and an ask at 1000-t are the same trade seen from the two
    // sides, so they must lock the same collateral.
    for (const tick of [100, 250, 400, 750]) {
      const bid = escrowOf({ priceTick: tick, amount: 1_000_000n, side: SIDE_BID });
      const ask = escrowOf({ priceTick: 1000 - tick, amount: 1_000_000n, side: SIDE_ASK });
      expect(bid).toBe(ask);
    }
  });
});

describe("myAccount", () => {
  it("totals credit, escrow and net across both sides", () => {
    seq = 0n;
    const snap = snapshot({
      bids: [order(ALICE, 400, 10, SIDE_BID), order(BOB, 400, 99, SIDE_BID)],
      asks: [order(ALICE, 600, 10, SIDE_ASK)],
      seats: [{ trader: ALICE, credit: 3n * ONE_SHARE_BASE, net: 5n * ONE_SHARE_BASE }],
    });
    const acct = myAccount(snap, ALICE);
    // bid 10 @ 0.40 locks 4; ask 10 @ 0.60 locks 4 (the 1-0.60 leg).
    expect(acct.escrow).toBe(8n * ONE_SHARE_BASE);
    expect(acct.credit).toBe(3n * ONE_SHARE_BASE);
    expect(acct.net).toBe(5n * ONE_SHARE_BASE);
    expect(acct.openOrders).toBe(2);
  });

  it("counts no one else's escrow", () => {
    // The book is one shared account, so only the filter keeps Bob's locked
    // collateral out of Alice's Trading Account.
    seq = 0n;
    const snap = snapshot({ bids: [order(BOB, 400, 50, SIDE_BID)] });
    expect(myAccount(snap, ALICE).escrow).toBe(0n);
  });

  it("reads as flat zeros for a trader who has never traded", () => {
    expect(myAccount(snapshot(), ALICE)).toEqual({
      credit: 0n,
      escrow: 0n,
      net: 0n,
      openOrders: 0,
    });
  });
});

describe("quoteSweep — self-owned liquidity", () => {
  // The matcher steps over the taker's own resting orders. A quote that counts
  // them promises a fill the chain will not give, and it is worst exactly when
  // the trader is making the market: their own order is often the best price,
  // so the quote is built almost entirely on liquidity they cannot take.
  it("skips the caller's own orders", () => {
    seq = 0n;
    const snap = snapshot({
      asks: [order(ALICE, 400, 1, SIDE_ASK), order(BOB, 500, 1, SIDE_ASK)],
    });
    const q = quoteSweep(snap, SIDE_BID, 2n * ONE_SHARE_BASE, undefined, ALICE);
    // Only Bob's share is reachable.
    expect(q.filled).toBe(ONE_SHARE_BASE);
    expect(q.cost).toBe(500_000n);
  });

  it("steps over them rather than stopping", () => {
    // The distinction that matters: Alice's 400 sits in FRONT of Bob's 500.
    // Stopping would report zero; skipping reaches Bob.
    seq = 0n;
    const snap = snapshot({
      asks: [order(ALICE, 400, 1, SIDE_ASK), order(BOB, 500, 5, SIDE_ASK)],
    });
    expect(quoteSweep(snap, SIDE_BID, 3n * ONE_SHARE_BASE, undefined, ALICE).filled).toBe(
      3n * ONE_SHARE_BASE,
    );
  });

  it("counts every order when no taker is given", () => {
    // An anonymous depth quote has no owner to exclude, so nothing is skipped.
    seq = 0n;
    const snap = snapshot({ asks: [order(ALICE, 400, 1, SIDE_ASK)] });
    expect(quoteSweep(snap, SIDE_BID, ONE_SHARE_BASE).filled).toBe(ONE_SHARE_BASE);
  });

  it("still honours the limit tick while skipping", () => {
    seq = 0n;
    const snap = snapshot({
      asks: [order(ALICE, 400, 1, SIDE_ASK), order(BOB, 700, 5, SIDE_ASK)],
    });
    const q = quoteSweep(snap, SIDE_BID, 5n * ONE_SHARE_BASE, 500, ALICE);
    expect(q.filled).toBe(0n);
  });
});

describe("selfCrossExposure", () => {
  // The matcher steps over the trader's own orders and CANCELS whatever
  // remainder would cross them. Correct, and invisible: the transaction
  // succeeds, nothing rests, and the order never appears. This is what lets
  // the UI say so before the trader spends a transaction wondering.
  it("flags an order that can only cross the trader's own", () => {
    seq = 0n;
    const snap = snapshot({ asks: [order(ALICE, 400, 5, SIDE_ASK)] });
    const r = selfCrossExposure(snap, ALICE, SIDE_BID, 500, 5n * ONE_SHARE_BASE);
    expect(r.crosses).toBe(true);
    expect(r.ownAmount).toBe(5n * ONE_SHARE_BASE);
    expect(r.othersAmount).toBe(0n);
  });

  it("does NOT flag it when other traders can fill the whole order", () => {
    // Only a REMAINDER is cancelled. An order that other liquidity covers
    // entirely is unaffected no matter how much of its own it crosses, so
    // warning here would be a false alarm on a trade that works fine.
    seq = 0n;
    const snap = snapshot({
      asks: [order(ALICE, 400, 5, SIDE_ASK), order(BOB, 450, 10, SIDE_ASK)],
    });
    const r = selfCrossExposure(snap, ALICE, SIDE_BID, 500, 5n * ONE_SHARE_BASE);
    expect(r.crosses).toBe(false);
    expect(r.othersAmount).toBe(10n * ONE_SHARE_BASE);
  });

  it("flags the shortfall when other liquidity is not enough", () => {
    seq = 0n;
    const snap = snapshot({
      asks: [order(ALICE, 400, 5, SIDE_ASK), order(BOB, 450, 2, SIDE_ASK)],
    });
    const r = selfCrossExposure(snap, ALICE, SIDE_BID, 500, 10n * ONE_SHARE_BASE);
    expect(r.crosses).toBe(true);
  });

  it("ignores the trader's own orders that do not cross", () => {
    // An order resting far away is irrelevant. Warning about it would make the
    // message fire constantly for anyone quoting both sides of a wide market.
    seq = 0n;
    const snap = snapshot({ asks: [order(ALICE, 900, 5, SIDE_ASK)] });
    expect(
      selfCrossExposure(snap, ALICE, SIDE_BID, 500, 5n * ONE_SHARE_BASE).crosses,
    ).toBe(false);
  });

  it("reproduces the reported case: buy YES and buy NO at the same price", () => {
    // "buy YES @51.5" is a bid at 515; "buy NO @51.5" is an ask at 485. The
    // second one crosses the first, and with nothing else on that side it is
    // cancelled in full — which is exactly what looked like a lost order.
    seq = 0n;
    const snap = snapshot({ bids: [order(ALICE, 515, 2, SIDE_BID)] });
    const r = selfCrossExposure(snap, ALICE, SIDE_ASK, 485, 2n * ONE_SHARE_BASE);
    expect(r.crosses).toBe(true);
    expect(r.ownAmount).toBe(2n * ONE_SHARE_BASE);
  });

  it("says nothing for a trader with no orders on that side", () => {
    seq = 0n;
    const snap = snapshot({ asks: [order(BOB, 400, 5, SIDE_ASK)] });
    expect(
      selfCrossExposure(snap, ALICE, SIDE_BID, 500, 5n * ONE_SHARE_BASE).crosses,
    ).toBe(false);
  });
});
