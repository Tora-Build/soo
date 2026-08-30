// "others" is the default bucket, not a verdict: markets filed there get a
// second opinion from their own question. Pinned against the three on-chain
// markets that motivated this — created with a hardcoded `§category others`
// above questions that plainly name their subject.
import { describe, expect, it } from "vitest";

import { effectiveCategory } from "../src/lib/categories";

describe("effectiveCategory", () => {
  it("re-files defaulted markets by their question text", () => {
    expect(
      effectiveCategory("others", "Will Bitcoin trade above $150,000 before 2027?"),
    ).toBe("crypto");
    expect(
      effectiveCategory(
        "others",
        "Will Solana process more daily transactions than Ethereum in 2027?",
      ),
    ).toBe("crypto");
    expect(
      effectiveCategory("others", "Will it rain in London on the first day of 2027?"),
    ).toBe("weather");
  });

  it("never overrides a specific stored category", () => {
    // The creator said sports; a mention of 'Bitcoin' in the question does
    // not outrank them.
    expect(
      effectiveCategory("sports", "Will the Bitcoin Cup final go to penalties?"),
    ).toBe("sports");
  });

  it("leaves a genuinely other market in others", () => {
    expect(
      effectiveCategory("others", "Will Zorblax the Unknowable appear?"),
    ).toBe("others");
  });
});
