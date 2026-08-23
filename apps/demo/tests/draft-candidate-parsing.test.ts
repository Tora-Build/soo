// The drafting service speaks "gte"; the chain enum speaks "Gte". Compared
// exactly, every candidate was dropped and the form said the model had nothing
// to offer — so this is the regression that made AI drafting appear to work
// end to end while never once filling the fields.

import { describe, expect, it } from "vitest";
import { parseCandidate } from "../src/components/features/launchpad/rule-services";

const wire = {
  url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
  parsePath: "$.data.amount",
  comparator: "gte",
  threshold: "100000",
  valueScale: 8,
  reading: "76612.395",
  rationale: "resolves YES if Coinbase spot BTC/USD is at or above 100,000",
  confidence: 0.99,
};

describe("parseCandidate", () => {
  it("accepts the service's lowercase comparator and maps it to the chain enum", () => {
    const c = parseCandidate(wire);
    expect(c).not.toBeNull();
    expect(c!.comparator).toBe("Gte");
    expect(c!.threshold).toBe("100000");
    expect(c!.reading).toBe("76612.395");
  });

  it("maps every comparator the service can return", () => {
    const pairs: Array<[string, string]> = [
      ["gt", "Gt"],
      ["gte", "Gte"],
      ["lt", "Lt"],
      ["lte", "Lte"],
      ["eq", "Eq"],
    ];
    for (const [from, to] of pairs) {
      expect(parseCandidate({ ...wire, comparator: from })?.comparator).toBe(to);
    }
  });

  it("still accepts the chain casing, so either convention works", () => {
    expect(parseCandidate({ ...wire, comparator: "Gte" })?.comparator).toBe("Gte");
  });

  it("rejects a comparator that is not one at all", () => {
    expect(parseCandidate({ ...wire, comparator: "above" })).toBeNull();
    expect(parseCandidate({ ...wire, comparator: 3 })).toBeNull();
  });

  it("rejects candidates the form could not fill", () => {
    expect(parseCandidate({ ...wire, url: "http://insecure.example" })).toBeNull();
    expect(parseCandidate({ ...wire, parsePath: "data.amount" })).toBeNull();
    expect(parseCandidate({ ...wire, threshold: "one hundred" })).toBeNull();
  });
});
