// A § envelope is delimited by its markers, not by newlines. Markets exist
// on-chain in both shapes, and the line-based reader silently produced an
// empty question for the single-line one — a blank card for a real market.
import { describe, expect, it } from "vitest";

import { parseSQF, generateSQF } from "../src/lib/sqf";

describe("parseSQF reads single-line envelopes", () => {
  it("extracts question and category from a one-line envelope", () => {
    const parsed = parseSQF(
      "§question Will the veto countdown render on this market? run=1787388084604 §category others",
    );
    expect(parsed.question).toBe(
      "Will the veto countdown render on this market? run=1787388084604",
    );
    expect(parsed.category).toBe("others");
  });

  it("still reads the multi-line shape it always did", () => {
    const parsed = parseSQF("§question\nWill BTC pass 100k?\n§category\ncrypto");
    expect(parsed.question).toBe("Will BTC pass 100k?");
    expect(parsed.category).toBe("crypto");
  });

  it("round-trips what generateSQF writes, icon included", () => {
    const parsed = parseSQF(
      generateSQF({ question: "Will SOL flip ETH?", icon: "◎", category: "crypto", rule: {} }),
    );
    expect(parsed.question).toBe("Will SOL flip ETH?");
    expect(parsed.icon).toBe("◎");
    expect(parsed.category).toBe("crypto");
  });
});
