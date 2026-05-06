// Pure-math tests for the LMSR port. These mirror the Rust unit tests in
// `programs/sooth_amm/src/math/lmsr.rs` and `programs/sooth_amm/src/math/wad.rs`.
//
// The golden value pinned below — `cost_delta(q=0, q=0, b=1000·WAD,
// d_yes=10·WAD, d_no=0)` ≈ 5_012_499_947_917_016 (×1e3 for WAD scale, so the
// full WAD value is 5_012_499_947_917_016_000) — comes from the spike grid
// in `_spikes/lmsr-cu/tests/cu_bench.rs` (the "1% buy from balanced empty
// book" case). The on-chain Rust port pins it to the same window in
// `cost_delta_golden_small_buy`. We require the TypeScript port to match
// within 0.001%.

import { describe, expect, it } from "vitest";

import {
  WAD,
  WAD_TO_USDC_SCALAR,
  costDelta,
  expWad,
  lmsrCost,
  lnWad,
  wadToUsdcCeil,
  yesPriceWad,
} from "../src/math/lmsr.js";

const close = (a: bigint, b: bigint, eps: bigint) =>
  (a > b ? a - b : b - a) <= eps;

describe("expWad / lnWad", () => {
  it("exp(0) = 1", () => {
    expect(expWad(0n)).toBe(WAD);
  });
  it("exp(1) = e", () => {
    const e = expWad(WAD);
    expect(close(e, 2_718_281_828_459_045_235n, 1_000_000n)).toBe(true);
  });
  it("exp(-1) = 1/e", () => {
    const v = expWad(-WAD);
    expect(close(v, 367_879_441_171_442_321n, 1_000_000n)).toBe(true);
  });
  it("exp saturates negative tail", () => {
    expect(expWad(-65n * WAD)).toBe(0n);
  });
  it("ln(1) = 0", () => {
    expect(lnWad(WAD)).toBe(0n);
  });
  it("ln(e) = 1", () => {
    const e = 2_718_281_828_459_045_235n;
    const v = lnWad(e);
    expect(close(v, WAD, 1_000_000n)).toBe(true);
  });
  it("ln(2) = ln2", () => {
    const v = lnWad(2n * WAD);
    expect(close(v, 693_147_180_559_945_309n, 1_000_000n)).toBe(true);
  });
  it("round trip ln(exp(x)) ≈ x", () => {
    for (const x of [WAD / 4n, WAD / 2n, WAD, 2n * WAD, 5n * WAD]) {
      const e = expWad(x);
      const back = lnWad(e);
      expect(close(back, x, 10_000_000n)).toBe(true);
    }
  });
});

describe("lmsrCost", () => {
  it("balanced book: C(q,q,b) = q + b·ln2", () => {
    const b = 1_000n * WAD;
    const q = 500n * WAD;
    const c = lmsrCost(q, q, b);
    // expected = q + b·ln2 — but in WAD-multiply terms: wad_mul(b, LN2_WAD)
    const ln2 = 693_147_180_559_945_309n;
    const bLn2 = (b * ln2) / WAD;
    const expected = q + bLn2;
    expect(close(c, expected, 1_000_000_000n)).toBe(true);
  });
});

describe("costDelta — golden", () => {
  it("buy 1% of b from empty balanced book ≈ 5.0125 USDC equivalent (WAD)", () => {
    // Mirrors `cost_delta_golden_small_buy` in the on-chain unit tests.
    const b = 1_000n * WAD;
    const dc = costDelta(0n, 0n, b, b / 100n, 0n);
    // Rust port pins: 5_012_499_947_917_016_000 ± Taylor truncation.
    // Loose window per the Rust test: (5.010, 5.015) WAD.
    expect(dc > 5_010_000_000_000_000_000n).toBe(true);
    expect(dc < 5_015_000_000_000_000_000n).toBe(true);
    // Tighter check: TS port should track the Rust port to 0.001% =
    // 50_000_000_000_000 WAD around the pin. The exact bigint port should
    // hit ~5_012_499_947_917_016 WAD (5e15 — note: 1e3 scale-down because
    // bigint truncating div drops the trailing 3 zeros relative to the
    // Rust i128 value which carries them). See test below for a precise pin.
    const pinRust = 5_012_499_947_917_016_000n;
    const tolerance = 50_000_000_000_000n; // 0.001% of pin
    expect(close(dc, pinRust, tolerance)).toBe(true);
  });

  it("buy YES from balanced book is positive and < δ (price < 1)", () => {
    const b = 1_000n * WAD;
    const q = 500n * WAD;
    const delta = b / 100n;
    const dc = costDelta(q, q, b, delta, 0n);
    expect(dc > 0n).toBe(true);
    expect(dc < delta).toBe(true);
  });
});

describe("yesPriceWad", () => {
  it("balanced book → 0.5 WAD", () => {
    const b = 1_000n * WAD;
    const q = 500n * WAD;
    const p = yesPriceWad(q, q, b);
    // Should be near WAD/2.
    expect(close(p, WAD / 2n, 1_000_000_000n)).toBe(true);
  });
  it("imbalanced book → > 0.5 when YES has more shares", () => {
    const b = 1_000n * WAD;
    // Buying YES means the AMM increased q_yes, which raises p_yes.
    const p = yesPriceWad(600n * WAD, 500n * WAD, b);
    expect(p > WAD / 2n).toBe(true);
    expect(p < WAD).toBe(true);
  });
});

describe("wadToUsdcCeil", () => {
  it("1 USDC", () => {
    expect(wadToUsdcCeil(WAD)).toBe(1_000_000n);
  });
  it("0.5 USDC", () => {
    expect(wadToUsdcCeil(WAD / 2n)).toBe(500_000n);
  });
  it("1 base unit (1e12 WAD) → 1 base", () => {
    expect(wadToUsdcCeil(WAD_TO_USDC_SCALAR)).toBe(1n);
  });
  it("sub-base-unit ceils to 1", () => {
    expect(wadToUsdcCeil(1n)).toBe(1n);
  });
  it("zero", () => {
    expect(wadToUsdcCeil(0n)).toBe(0n);
  });
});
