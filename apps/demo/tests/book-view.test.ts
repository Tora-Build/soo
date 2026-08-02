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
  myOrders,
  myPosition,
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
