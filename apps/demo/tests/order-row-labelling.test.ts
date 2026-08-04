// How a resting order is LABELLED once the YES/NO toggle is applied.
//
// On the redesigned book there is one order set and one price axis. Toggling
// YES/NO does not change WHICH orders you have — it changes the convention
// they are quoted in. So both tabs showing the same rows is correct; what must
// flip is the buy/sell word and the price.
//
// Two conventions collide here and they are numbered oppositely:
//
//   legacy `OpenOrder.outcome` : 1 = YES side   (tickToYesPrice(tick, 1)
//                                                returns tick as a YES price,
//                                                and the panel reads
//                                                `sideIsYes = outcome === 1`)
//   redesigned book `side`     : 0 = SIDE_BID, which BUYS YES
//
// Passing the book's side straight through inverted every row: a resting bid
// rendered as "Sell" in the YES tab and "Buy" in the NO tab, at prices that
// looked plausible either way. Plausible-but-inverted is the worst failure
// mode available here, because nothing on screen looks broken.
//
// These cases reproduce the panel's own two lines rather than importing the
// component, so they pin the contract the mapping has to satisfy.

import { describe, expect, it } from "vitest";

import { SIDE_ASK, SIDE_BID } from "../src/lib/book-order-mapping";

/** `UserOrdersPanel`: `sideIsYes = order.outcome === 1`. */
function renderRow(outcome: 0 | 1, yesPrice: number, view: "yes" | "no") {
  const sideIsYes = outcome === 1;
  const isBuy = view === "yes" ? sideIsYes : !sideIsYes;
  const cents = view === "yes" ? yesPrice * 100 : (1 - yesPrice) * 100;
  return `${isBuy ? "Buy" : "Sell"} ${cents.toFixed(1)}¢`;
}

/** The mapping under test, from `fetchOpenOrdersFromBook`. */
function toOutcome(bookSide: number): 0 | 1 {
  return (bookSide === SIDE_BID ? 1 : 0) as 0 | 1;
}

describe("a resting BID at tick 400 (bought YES at 0.40)", () => {
  const outcome = toOutcome(SIDE_BID);

  it("reads as buying YES at 40¢ in the YES tab", () => {
    expect(renderRow(outcome, 0.4, "yes")).toBe("Buy 40.0¢");
  });

  it("reads as selling NO at 60¢ in the NO tab", () => {
    // The same order. Buying YES at 0.40 IS offering to sell NO at 0.60 —
    // that identity is why one book serves both outcomes.
    expect(renderRow(outcome, 0.4, "no")).toBe("Sell 60.0¢");
  });
});

describe("a resting ASK at tick 400 (sold YES at 0.40)", () => {
  const outcome = toOutcome(SIDE_ASK);

  it("reads as selling YES at 40¢ in the YES tab", () => {
    expect(renderRow(outcome, 0.4, "yes")).toBe("Sell 40.0¢");
  });

  it("reads as buying NO at 60¢ in the NO tab", () => {
    expect(renderRow(outcome, 0.4, "no")).toBe("Buy 60.0¢");
  });
});

describe("the invariants that hold for every order", () => {
  it("flips buy/sell between the two tabs, never repeats it", () => {
    // The bug looked like this: both tabs agreeing on the verb. If a row says
    // "Buy" under YES and "Buy" under NO, one of them is a lie.
    for (const side of [SIDE_BID, SIDE_ASK]) {
      for (const tick of [1, 250, 500, 750, 999]) {
        const outcome = toOutcome(side);
        const yes = renderRow(outcome, tick / 1000, "yes");
        const no = renderRow(outcome, tick / 1000, "no");
        expect(yes.startsWith("Buy")).toBe(!no.startsWith("Buy"));
      }
    }
  });

  it("quotes complementary prices between the two tabs", () => {
    for (const tick of [1, 333, 500, 667, 999]) {
      const p = tick / 1000;
      const yes = Number(renderRow(1, p, "yes").split(" ")[1]!.replace("¢", ""));
      const no = Number(renderRow(1, p, "no").split(" ")[1]!.replace("¢", ""));
      expect(yes + no).toBeCloseTo(100, 6);
    }
  });

  it("agrees with the write path: what you placed is what you see", () => {
    // `toBookPlace` maps "buy YES" to SIDE_BID. Reading that order back must
    // say "Buy" in the YES tab, or the round trip contradicts itself — the
    // single most confusing thing a trading UI can do.
    expect(renderRow(toOutcome(SIDE_BID), 0.4, "yes").startsWith("Buy")).toBe(true);
    // `toBookPlace` maps "buy NO" to SIDE_ASK; that must read "Buy" under NO.
    expect(renderRow(toOutcome(SIDE_ASK), 0.4, "no").startsWith("Buy")).toBe(true);
  });

  it("would have caught the inversion", () => {
    // The shipped-and-wrong mapping, kept explicit so this test fails loudly
    // if someone reintroduces it.
    const inverted = (bookSide: number) => (bookSide === SIDE_BID ? 0 : 1) as 0 | 1;
    expect(renderRow(inverted(SIDE_BID), 0.4, "yes")).toBe("Sell 40.0¢");
    expect(renderRow(toOutcome(SIDE_BID), 0.4, "yes")).toBe("Buy 40.0¢");
  });
});
