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

  it("round-trips what generateSQF writes", () => {
    const parsed = parseSQF(
      generateSQF({ question: "Will SOL flip ETH?", category: "crypto", rule: {} }),
    );
    expect(parsed.question).toBe("Will SOL flip ETH?");
    expect(parsed.category).toBe("crypto");
  });

  it("ignores the retired §icon section on markets that carry one", () => {
    // Markets created while icons rode the envelope still parse cleanly —
    // the section is simply unread, and those markets render through the
    // same fallback chain as everyone else.
    const parsed = parseSQF("§question\nQ?\n§icon\nhttps://e.com/x.png\n§category\ncrypto");
    expect(parsed.question).toBe("Q?");
    expect(parsed.category).toBe("crypto");
    expect((parsed as { icon?: string }).icon).toBeUndefined();
  });
});
