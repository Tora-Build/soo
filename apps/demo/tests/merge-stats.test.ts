// The XP merge — the rule that decides whether a daily drop visibly pays.
//
// The regression this guards: a wallet with 2,680 chain XP and 1,510 server
// XP claimed a daily drop, the server credited +250, and the screen did not
// move — the old rule was a maximum over mixed totals, and the +250 landed
// on the ledger the maximum had discarded.

import { describe, expect, it } from "vitest";
import { mergeStats } from "../src/features/arena/mergeStats";

const LOCAL = { xp: 0, streak: 0, plays: 0, tickets: 3 };

describe("mergeStats", () => {
  it("a daily drop moves the number even when chain play XP dominates", () => {
    const before = mergeStats({
      profile: { xp: 1510, socialXp: 1250, playsXp: 260, streak: 5, plays: 4, tickets: 2 },
      chain: { xp: 2680, streakDays: 2, plays: 21 },
      local: LOCAL,
    });
    const after = mergeStats({
      profile: { xp: 1760, socialXp: 1500, playsXp: 260, streak: 6, plays: 4, tickets: 3 },
      chain: { xp: 2680, streakDays: 2, plays: 21 },
      local: LOCAL,
    });
    expect(before.xp).toBe(2680 + 1250);
    expect(after.xp).toBe(2680 + 1500);
    expect(after.xp - before.xp).toBe(250);
    expect(after.tickets).toBe(3);
  });

  it("play XP is a maximum, never a sum — both ledgers score the same trades", () => {
    const r = mergeStats({
      profile: { xp: 500, socialXp: 0, playsXp: 500, streak: 1, plays: 5, tickets: 1 },
      chain: { xp: 480, streakDays: 1, plays: 5 },
      local: LOCAL,
    });
    expect(r.xp).toBe(500);
  });

  it("streak takes the widest honest measure of showing up", () => {
    const r = mergeStats({
      profile: { xp: 0, socialXp: 0, playsXp: 0, streak: 6, plays: 0, tickets: 3 },
      chain: { xp: 100, streakDays: 2, plays: 1 },
      local: LOCAL,
    });
    expect(r.streak).toBe(6);
  });

  it("an unsplit (older) server profile falls back to the maximum rule", () => {
    const r = mergeStats({
      profile: { xp: 1510, streak: 5, plays: 4, tickets: 2 },
      chain: { xp: 2680, streakDays: 2, plays: 21 },
      local: LOCAL,
    });
    expect(r.xp, "no double count when the split is unknown").toBe(2680);
  });

  it("guests keep the old rule — the local ledger has no split to exploit", () => {
    const r = mergeStats({
      profile: null,
      chain: { xp: 100, streakDays: 1, plays: 2 },
      local: { xp: 750, streak: 3, plays: 2, tickets: 4 },
    });
    expect(r.xp).toBe(750);
    expect(r.tickets).toBe(4);
  });
});
