// The stage words, pinned. "Live" once meant GRADUATED, so a graduated
// market whose deadline had passed matched the LIVE filter while its own
// card said trading was closed. Live now means tradeable — on either venue —
// and the venue has its own word.
import { describe, expect, it } from "vitest";

import { displayStage, matchesStageFilter } from "../src/pages/Markets";

const NOW = Math.floor(Date.now() / 1000);
const future = NOW + 7 * 86400;
const past = NOW - 86400;

describe("displayStage", () => {
  it("names the venue of a market that can trade", () => {
    expect(displayStage({ stage: "bonding", deadline: future })).toBe("bonding");
    expect(displayStage({ stage: "orderbook", deadline: future })).toBe("orderbook");
  });

  it("calls a past-deadline market ended, whatever its venue", () => {
    expect(displayStage({ stage: "orderbook", deadline: past })).toBe("ended");
    expect(displayStage({ stage: "bonding", deadline: past })).toBe("ended");
  });

  it("calls a LOCKED market ended even with a future deadline", () => {
    // Mid-resolution: the program rejects every trade.
    expect(
      displayStage({ stage: "bonding", deadline: future, isLive: false }),
    ).toBe("ended");
  });

  it("passes terminal states through untouched", () => {
    for (const stage of ["settled", "finalized", "dismissed"]) {
      expect(displayStage({ stage, deadline: future })).toBe(stage);
    }
  });
});

describe("the LIVE filter is the union of both venues", () => {
  const bonding = { stage: "bonding", deadline: future };
  const book = { stage: "orderbook", deadline: future };
  const ended = { stage: "orderbook", deadline: past };

  it("selects AMM-only and graduated markets alike", () => {
    expect(matchesStageFilter(bonding, "live")).toBe(true);
    expect(matchesStageFilter(book, "live")).toBe(true);
  });

  it("excludes anything that cannot take a trade", () => {
    expect(matchesStageFilter(ended, "live")).toBe(false);
    expect(matchesStageFilter({ stage: "settled" }, "live")).toBe(false);
  });

  it("keeps the venue tabs exclusive", () => {
    expect(matchesStageFilter(bonding, "bonding")).toBe(true);
    expect(matchesStageFilter(bonding, "orderbook")).toBe(false);
    expect(matchesStageFilter(book, "orderbook")).toBe(true);
  });

  it("lets ALL through unconditionally", () => {
    expect(matchesStageFilter(ended, "all")).toBe(true);
  });
});
