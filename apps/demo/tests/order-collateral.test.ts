// What an order costs, and whether the form lets it through.
//
// The demo blocked every sell larger than the trader's token holding:
//
//   "Sell burns shares (escrow). Short selling without shares is not supported
//    by the demo flow today — block any sell where requested > held."
//
// True on the EVM book, where selling YES delivers YES tokens and you must
// mint a $1 pair before you can sell either leg. Not true on the redesigned
// book: a YES and a NO always sum to $1, so selling YES at p IS buying NO at
// (1 - p), collateralised in USDC, with the seat carrying the negative
// position. Verified on chain — a wallet holding only USDC reached net -2
// having never held an outcome token.
//
// So the gate rejected orders the program accepts. These cases pin both
// regimes, because the legacy path still needs the old rule.

import { describe, expect, it } from "vitest";

import { orderCollateral } from "../src/lib/order-collateral";

const base = {
  shares: 10,
  price: 0.4,
  isBuying: true,
  isYes: true,
  availableUsdc: 100,
  availableShares: 0,
  redesignedBook: true,
};

describe("what an order costs", () => {
  it("charges price × shares to buy", () => {
    const c = orderCollateral({ ...base, shares: 10, price: 0.4 });
    expect(c.kind).toBe("usdc");
    expect(c.required).toBeCloseTo(4, 10);
  });

  it("charges the COMPLEMENT to sell", () => {
    // Selling YES at 0.40 is buying NO at 0.60, so it costs 0.60 a share. The
    // seller is not "receiving" 0.40 — both sides of this book pay in, and the
    // two payments sum to $1 a pair.
    const c = orderCollateral({ ...base, isBuying: false, shares: 10, price: 0.4 });
    expect(c.kind).toBe("usdc");
    expect(c.required).toBeCloseTo(6, 10);
  });

  it("has the two directions sum to the pair price", () => {
    // The arithmetic the program uses to split a fill. If these ever stopped
    // summing to `shares`, the number shown here would stop matching what gets
    // escrowed.
    for (const price of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      const buy = orderCollateral({ ...base, isBuying: true, shares: 10, price });
      const sell = orderCollateral({ ...base, isBuying: false, shares: 10, price });
      expect(buy.required + sell.required).toBeCloseTo(10, 10);
    }
  });
});

describe("selling on the redesigned book", () => {
  it("is allowed with zero shares held", () => {
    // The whole point. Nothing to deliver, nothing to mint first.
    const c = orderCollateral({
      ...base,
      isBuying: false,
      shares: 10,
      price: 0.4,
      availableShares: 0,
      availableUsdc: 100,
    });
    expect(c.error).toBeNull();
  });

  it("is still gated on USDC, at the complement price", () => {
    // Not "anything goes" — the collateral is real, it is just denominated in
    // USDC. 10 shares at 0.40 needs $6, and $5 is not enough.
    const c = orderCollateral({
      ...base,
      isBuying: false,
      shares: 10,
      price: 0.4,
      availableUsdc: 5,
    });
    expect(c.kind).toBe("usdc");
    expect(c.error).toMatch(/Insufficient USDC/);
  });

  it("never reports a share shortfall", () => {
    // The old message named the outcome token; surfacing it here would tell
    // the trader to go mint a pair, which is exactly the step this removes.
    const c = orderCollateral({
      ...base,
      isBuying: false,
      shares: 1_000,
      price: 0.4,
      availableShares: 0,
      availableUsdc: 10_000,
    });
    expect(c.error).toBeNull();
    expect(c.kind).not.toBe("shares");
  });
});

describe("selling on the legacy book", () => {
  it("still requires the tokens", () => {
    // The legacy write path really does deliver tokens, so the old rule holds
    // there and must not be relaxed along with the new one.
    const c = orderCollateral({
      ...base,
      redesignedBook: false,
      isBuying: false,
      shares: 10,
      availableShares: 3,
    });
    expect(c.kind).toBe("shares");
    expect(c.error).toMatch(/Insufficient YES/);
  });

  it("passes when the trader holds enough", () => {
    const c = orderCollateral({
      ...base,
      redesignedBook: false,
      isBuying: false,
      shares: 10,
      availableShares: 10,
    });
    expect(c.error).toBeNull();
  });

  it("names the outcome actually being sold", () => {
    const c = orderCollateral({
      ...base,
      redesignedBook: false,
      isBuying: false,
      isYes: false,
      shares: 10,
      availableShares: 0,
    });
    expect(c.error).toMatch(/Insufficient NO/);
  });
});

describe("buying is unchanged in both regimes", () => {
  it("is gated on USDC either way", () => {
    for (const redesignedBook of [true, false]) {
      const c = orderCollateral({
        ...base,
        redesignedBook,
        isBuying: true,
        shares: 10,
        price: 0.4,
        availableUsdc: 3,
      });
      expect(c.kind).toBe("usdc");
      expect(c.error).toMatch(/Insufficient USDC/);
    }
  });
});

describe("an empty form is not an error", () => {
  it("reports nothing at zero size", () => {
    // The form renders before anything is typed; a validation error there
    // reads as "something is wrong" when the trader has simply not started.
    for (const isBuying of [true, false]) {
      for (const redesignedBook of [true, false]) {
        const c = orderCollateral({
          ...base,
          shares: 0,
          isBuying,
          redesignedBook,
          availableUsdc: 0,
          availableShares: 0,
        });
        expect(c.error).toBeNull();
      }
    }
  });
});
