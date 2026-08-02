// Mapping the order form onto `book_place`.
//
// Three encodings meet in this function — the form's, the hook's INVERTED
// outcome convention (0 = YES), and the book's single YES axis. Getting any of
// them backwards submits a real order on the wrong side of the market at the
// complement price, which is a silent loss of money rather than an error.
//
// So every quadrant is asserted explicitly, and the two identities that make
// the unified axis work are asserted directly rather than inferred.

import { describe, expect, it } from "vitest";

import {
  MAX_TICK,
  MIN_TICK,
  NUM_TICKS,
  OrderMappingError,
  SIDE_ASK,
  SIDE_BID,
  WAD_TO_BASE,
  priceToTick,
  sharesWadToBase,
  toBookPlace,
} from "../src/lib/book-order-mapping";

const YES = 0 as const; // inverted encoding
const NO = 1 as const;
const TEN_SHARES = 10n * 10n ** 18n;

function place(outcome: 0 | 1, price: number, isBuy: boolean) {
  return toBookPlace({ outcome, price, sharesWad: TEN_SHARES, isBuy });
}

describe("priceToTick", () => {
  it("scales a decimal price to the tick grid", () => {
    expect(priceToTick(0.4)).toBe(400);
    expect(priceToTick(0.999)).toBe(999);
    expect(priceToTick(0.001)).toBe(1);
  });

  it("clamps to the tradeable range rather than throwing", () => {
    // 0 is free and 1000 is certain; neither can rest. Clamping matches the
    // legacy clampTick, so a slider at either extreme still places an order
    // instead of producing an error toast.
    expect(priceToTick(0)).toBe(MIN_TICK);
    expect(priceToTick(1)).toBe(MAX_TICK);
    expect(priceToTick(-5)).toBe(MIN_TICK);
    expect(priceToTick(99)).toBe(MAX_TICK);
  });

  it("rejects a non-finite price", () => {
    expect(() => priceToTick(NaN)).toThrow(OrderMappingError);
    expect(() => priceToTick(Infinity)).toThrow(OrderMappingError);
  });
});

describe("sharesWadToBase", () => {
  it("converts WAD shares to base units", () => {
    expect(sharesWadToBase(10n ** 18n)).toBe(1_000_000n);
    expect(sharesWadToBase(TEN_SHARES)).toBe(10_000_000n);
  });

  it("rejects an order that would round to zero size", () => {
    // Submitting it would cost the user a transaction fee for nothing.
    expect(() => sharesWadToBase(WAD_TO_BASE - 1n)).toThrow(OrderMappingError);
    expect(() => sharesWadToBase(0n)).toThrow(OrderMappingError);
  });
});

describe("toBookPlace — the four quadrants", () => {
  it("buy YES at p → BID at p", () => {
    const r = place(YES, 0.4, true);
    expect(r.side).toBe(SIDE_BID);
    expect(r.limitTick).toBe(400);
  });

  it("sell YES at p → ASK at p", () => {
    const r = place(YES, 0.4, false);
    expect(r.side).toBe(SIDE_ASK);
    expect(r.limitTick).toBe(400);
  });

  it("buy NO at q → ASK at 1 - q", () => {
    // Buying NO is selling YES. This identity is why the book needs one axis,
    // and it is where the legacy path spent a buyNo-at-oppositeTick special
    // case per direction.
    const r = place(NO, 0.4, true);
    expect(r.side).toBe(SIDE_ASK);
    expect(r.limitTick).toBe(600);
  });

  it("sell NO at q → BID at 1 - q", () => {
    const r = place(NO, 0.4, false);
    expect(r.side).toBe(SIDE_BID);
    expect(r.limitTick).toBe(600);
  });
});

describe("toBookPlace — the identities the unified axis rests on", () => {
  it("buying NO at q is exactly selling YES at 1 - q", () => {
    const buyNo = place(NO, 0.3, true);
    const sellYes = place(YES, 0.7, false);
    expect(buyNo.side).toBe(sellYes.side);
    expect(buyNo.limitTick).toBe(sellYes.limitTick);
  });

  it("selling NO at q is exactly buying YES at 1 - q", () => {
    const sellNo = place(NO, 0.3, false);
    const buyYes = place(YES, 0.7, true);
    expect(sellNo.side).toBe(buyYes.side);
    expect(sellNo.limitTick).toBe(buyYes.limitTick);
  });

  it("a YES order and the NO order at its complement land on the same tick", () => {
    for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const yes = place(YES, p, true);
      const no = place(NO, Number((1 - p).toFixed(4)), false);
      expect(no.limitTick).toBe(yes.limitTick);
      expect(no.side).toBe(yes.side);
    }
  });

  it("honours the hook's INVERTED outcome encoding", () => {
    // outcome === 0 is YES here, the opposite of the protocol's canonical
    // 0 = NO. The inversion is load-bearing at the call site, so "correcting"
    // it halfway up the stack would flip every order silently.
    expect(place(0, 0.4, true).limitTick).toBe(400); // YES
    expect(place(1, 0.4, true).limitTick).toBe(600); // NO → complement
  });
});

describe("toBookPlace — bounds and defaults", () => {
  it("keeps the complement inside the tradeable range", () => {
    // A NO order at the very edge complements to the opposite edge; neither
    // may leave 1..999.
    expect(place(NO, 0.001, true).limitTick).toBe(MAX_TICK);
    expect(place(NO, 0.999, true).limitTick).toBe(MIN_TICK);
    expect(place(NO, 0, true).limitTick).toBe(MAX_TICK);
    expect(place(NO, 1, true).limitTick).toBe(MIN_TICK);
  });

  it("converts size to base units", () => {
    expect(place(YES, 0.5, true).amount).toBe(10_000_000n);
  });

  it("defaults to posting the remainder with a bounded match limit", () => {
    const r = place(YES, 0.5, true);
    expect(r.postRemainder).toBe(true);
    // Bounds compute, not correctness — the program stops early and rests the
    // rest rather than failing.
    expect(r.matchLimit).toBeGreaterThan(0);
  });

  it("lets the caller override both", () => {
    const r = toBookPlace({
      outcome: YES,
      price: 0.5,
      sharesWad: TEN_SHARES,
      isBuy: true,
      matchLimit: 32,
      postRemainder: false,
    });
    expect(r.matchLimit).toBe(32);
    expect(r.postRemainder).toBe(false);
  });

  it("rounds the complement in tick space, not on the decimal", () => {
    // Complementing the decimal first and rounding after can disagree with
    // rounding first — 1 - 0.3333 is 0.6667, which rounds to 667, but the
    // complement of tick 333 is 667 either way only if both steps agree.
    const r = place(NO, 0.3333, true);
    expect(r.limitTick).toBe(NUM_TICKS - priceToTick(0.3333));
  });
});
