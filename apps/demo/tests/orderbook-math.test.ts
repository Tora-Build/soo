// Characterisation tests for the demo's orderbook arithmetic.
//
// Until now these paths had NO unit coverage: the demo's other tests cover
// AMM, markets, portfolio and rendering, and the tick ladder, price conversion,
// cancel-by-level parser and refund maths were reachable only through
// Surfpool-gated e2e specs — which do not run in CI.
//
// They are written BEFORE the orderbook migration, not after, because the
// redesign changes what a tick means. The new book quotes a single unified YES
// axis, so the complement flip disappears; these tests are what will show that
// removing it is a simplification rather than a silent inversion of the market.

import { describe, expect, it } from "vitest";

import {
  MAX_TICK,
  MIN_TICK,
  NUM_TICKS,
  clampUnit,
  levelOrderId,
  parseOrderId,
  refundAmountWad,
  tickToYesPrice,
} from "../src/lib/orderbook-math";

describe("tickToYesPrice", () => {
  it("quotes a YES order at its own tick", () => {
    expect(tickToYesPrice(600, 1)).toBeCloseTo(0.6, 10);
    expect(tickToYesPrice(1, 1)).toBeCloseTo(0.001, 10);
    expect(tickToYesPrice(999, 1)).toBeCloseTo(0.999, 10);
  });

  it("quotes a NO order at the complement", () => {
    // The flip every display surface has to remember. A NO order at 0.40 is a
    // YES price of 0.60, and rendering it as 0.40 shows the wrong side of the
    // market at a glance-identical number.
    expect(tickToYesPrice(400, 0)).toBeCloseTo(0.6, 10);
    expect(tickToYesPrice(600, 0)).toBeCloseTo(0.4, 10);
  });

  it("the two sides of a tick always sum to 1", () => {
    for (const tick of [1, 137, 500, 501, 999]) {
      expect(tickToYesPrice(tick, 1) + tickToYesPrice(tick, 0)).toBeCloseTo(1, 10);
    }
  });

  it("clamps rather than emitting an out-of-range price", () => {
    // Defensive: a bad tick should render as 0 or 1, not as 1.5, which would
    // propagate into charts and percentage bars.
    expect(tickToYesPrice(1500, 1)).toBe(1);
    expect(tickToYesPrice(-100, 1)).toBe(0);
    expect(tickToYesPrice(1500, 0)).toBe(0);
  });

  it("clampUnit bounds to [0, 1]", () => {
    expect(clampUnit(-1)).toBe(0);
    expect(clampUnit(2)).toBe(1);
    expect(clampUnit(0.42)).toBe(0.42);
  });
});

describe("refundAmountWad", () => {
  it("returns the escrow a resting order posted", () => {
    // 10 shares at tick 400 escrows 4 USDC-equivalent in WAD.
    const tenShares = 10n * 10n ** 18n;
    expect(refundAmountWad(400n, tenShares)).toBe(4n * 10n ** 18n);
  });

  it("is proportional in both tick and amount", () => {
    const amt = 10n ** 18n;
    expect(refundAmountWad(500n, amt)).toBe(refundAmountWad(250n, amt) * 2n);
    expect(refundAmountWad(300n, amt * 3n)).toBe(refundAmountWad(300n, amt) * 3n);
  });

  it("floors — it never over-refunds", () => {
    // This is money paid out of a shared vault. Rounding up would let a
    // cancel-and-repost loop drain a fraction each time.
    expect(refundAmountWad(1n, 999n)).toBe(0n);
    expect(refundAmountWad(333n, 10n)).toBe(3n);
  });

  it("hardcodes the 1000-tick denominator", () => {
    // Pinned deliberately: this is a displayed money figure, and a change to
    // tick granularity silently misreports every refund unless it moves too.
    expect(refundAmountWad(BigInt(NUM_TICKS), 777n)).toBe(777n);
  });
});

describe("parseOrderId", () => {
  it("reads a real on-chain order id", () => {
    expect(parseOrderId("12345")).toEqual({ kind: "id", orderId: 12345n });
    // u64-scale ids must not lose precision through Number.
    const big = "18446744073709551615";
    expect(parseOrderId(big)).toEqual({ kind: "id", orderId: BigInt(big) });
  });

  it("round-trips the synthesised level id", () => {
    for (const side of [0, 1] as const) {
      for (const tick of [1, 250, 999]) {
        expect(parseOrderId(levelOrderId(side, tick))).toEqual({
          kind: "level",
          side,
          tick,
        });
      }
    }
  });

  it("rejects empty and unparseable input", () => {
    expect(parseOrderId("")).toBeNull();
    expect(parseOrderId("   ")).toBeNull();
    expect(parseOrderId("no-digits-here")).toBeNull();
  });

  it("rejects ticks outside the tradeable range", () => {
    // 0 is free and 1000 is certain; neither can rest.
    expect(parseOrderId("1:0")).toBeNull();
    expect(parseOrderId("yes-0")).toBeNull();
    expect(parseOrderId(`yes-${NUM_TICKS}`)).toBeNull();
    expect(parseOrderId(`yes-${MIN_TICK}`)).toEqual({
      kind: "level",
      side: 1,
      tick: MIN_TICK,
    });
    expect(parseOrderId(`yes-${MAX_TICK}`)).toEqual({
      kind: "level",
      side: 1,
      tick: MAX_TICK,
    });
  });

  it("infers the side from substrings in the fallback path", () => {
    // Characterised, not endorsed. This scrapes trailing digits off arbitrary
    // strings and guesses the side from a substring match.
    expect(parseOrderId("no-400")).toEqual({ kind: "level", side: 0, tick: 400 });
    expect(parseOrderId("ask-400")).toEqual({ kind: "level", side: 0, tick: 400 });
    expect(parseOrderId("yes-400")).toEqual({ kind: "level", side: 1, tick: 400 });
    expect(parseOrderId("bid-400")).toEqual({ kind: "level", side: 1, tick: 400 });
  });

  it("defaults to the YES side when nothing indicates otherwise", () => {
    expect(parseOrderId("order-400")).toEqual({ kind: "level", side: 1, tick: 400 });
  });

  it("the substring guess beats the explicit prefix — a known sharp edge", () => {
    // "1:400" parses as side 1 via the direct branch. But a string that merely
    // CONTAINS "no" wins the fallback regardless of what precedes it, so an id
    // like "unknown-400" resolves to the NO side. Cancelling the wrong side of
    // a level is a real user-visible bug, and the reason the redesigned book
    // gives every order a real `seq` and deletes this path entirely.
    expect(parseOrderId("unknown-400")).toEqual({
      kind: "level",
      side: 0,
      tick: 400,
    });
  });

  it("takes only the last three digits from a longer suffix", () => {
    // "yes-12345" yields tick 345, not 12345 — silently cancelling a level the
    // user never named.
    expect(parseOrderId("yes-12345")).toEqual({
      kind: "level",
      side: 1,
      tick: 345,
    });
  });

  it("is case-insensitive and trims", () => {
    expect(parseOrderId("  YES-400  ")).toEqual({
      kind: "level",
      side: 1,
      tick: 400,
    });
  });
});
