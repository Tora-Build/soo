// The scoring module is the arena's rulebook: every client folding the same
// on-chain play tape must land on the same board. These tests pin the rules
// — base gain, capped size bonus, one-shot discovery bonus, and the
// daily-streak multiplier — plus the fold's determinism.

import { describe, expect, it } from "vitest";
import {
  BASE_PLAY_XP,
  buildLeaderboard,
  DISCOVERY_BONUS_XP,
  scoreWallet,
  seasonTotals,
  SIZE_BONUS_CAP_XP,
  sizeBonusXp,
  streakMultiplier,
  utcDayOf,
  type ChainPlay,
} from "../src/features/arena/scoring";

const WAD = 10n ** 18n;
const DAY = 86_400;

let seq = 0;
const play = (overrides: Partial<ChainPlay> = {}): ChainPlay => ({
  wallet: "W1",
  market: "M1",
  venue: "amm",
  sizeWad: 3n * WAD,
  costWad: 2n * WAD,
  ts: 1_700_000_000,
  signature: `sig-${seq++}`,
  ...overrides,
});

describe("size bonus", () => {
  it("pays +1 XP per whole USDC of notional", () => {
    expect(sizeBonusXp({ sizeWad: WAD, costWad: 42n * WAD })).toBe(42);
  });

  it("floors sub-dollar notional to zero", () => {
    expect(sizeBonusXp({ sizeWad: WAD, costWad: WAD / 2n })).toBe(0);
  });

  it("caps at +150 so one whale trade cannot own the board", () => {
    expect(sizeBonusXp({ sizeWad: WAD, costWad: 100_000n * WAD })).toBe(
      SIZE_BONUS_CAP_XP,
    );
  });

  it("falls back to share size when the event carries no cost", () => {
    expect(sizeBonusXp({ sizeWad: 7n * WAD })).toBe(7);
  });
});

describe("streak multiplier", () => {
  it("steps 1.0 / 1.1 / 1.25 / 1.5 at 1 / 2 / 3 / 7 days", () => {
    expect(streakMultiplier(1)).toBe(1.0);
    expect(streakMultiplier(2)).toBe(1.1);
    expect(streakMultiplier(3)).toBe(1.25);
    expect(streakMultiplier(6)).toBe(1.25);
    expect(streakMultiplier(7)).toBe(1.5);
    expect(streakMultiplier(30)).toBe(1.5);
  });
});

describe("scoreWallet", () => {
  it("scores a single play: base + size bonus + discovery", () => {
    const score = scoreWallet("W1", [play({ costWad: 10n * WAD })]);
    expect(score.xp).toBe(BASE_PLAY_XP + 10 + DISCOVERY_BONUS_XP);
    expect(score.plays).toBe(1);
    expect(score.streakDays).toBe(1);
    expect(score.volumeUsdc).toBe(10);
  });

  it("awards the discovery bonus once per market, case-insensitively", () => {
    const t = 1_700_000_000;
    const score = scoreWallet("W1", [
      play({ market: "Mkt", ts: t, costWad: 0n }),
      play({ market: "mkt", ts: t + 60, costWad: 0n }),
      play({ market: "other", ts: t + 120, costWad: 0n }),
    ]);
    expect(score.xp).toBe(3 * BASE_PLAY_XP + 2 * DISCOVERY_BONUS_XP);
  });

  it("multiplies each day's plays by the streak length as of that day", () => {
    const day0 = 1_700_006_400; // mid-day, so +DAY stays on the next UTC day
    const score = scoreWallet("W1", [
      play({ market: "a", ts: day0, costWad: 0n }), // day 1: ×1.0, +discovery
      play({ market: "a", ts: day0 + DAY, costWad: 0n }), // day 2: ×1.1
      play({ market: "a", ts: day0 + 2 * DAY, costWad: 0n }), // day 3: ×1.25
    ]);
    expect(score.xp).toBe(
      Math.floor((BASE_PLAY_XP + DISCOVERY_BONUS_XP) * 1.0) +
        Math.floor(BASE_PLAY_XP * 1.1) +
        Math.floor(BASE_PLAY_XP * 1.25),
    );
    expect(score.streakDays).toBe(3);
  });

  it("resets the streak when a day is skipped", () => {
    const day0 = 1_700_006_400;
    const score = scoreWallet("W1", [
      play({ ts: day0, costWad: 0n }),
      play({ ts: day0 + DAY, costWad: 0n }),
      play({ ts: day0 + 3 * DAY, costWad: 0n }), // gap: back to day 1 of a run
    ]);
    expect(score.streakDays).toBe(1);
  });

  it("is order-independent — the chain tape's order does not matter", () => {
    const day0 = 1_700_006_400;
    const plays = [
      play({ market: "a", ts: day0 + DAY, costWad: 5n * WAD }),
      play({ market: "b", ts: day0, costWad: 3n * WAD }),
      play({ market: "a", ts: day0 + 2 * DAY, costWad: 0n }),
    ];
    const forward = scoreWallet("W1", plays);
    const reversed = scoreWallet("W1", [...plays].reverse());
    expect(reversed).toEqual(forward);
  });

  it("streak days follow UTC boundaries", () => {
    expect(utcDayOf(DAY - 1)).toBe(0);
    expect(utcDayOf(DAY)).toBe(1);
  });
});

describe("buildLeaderboard + seasonTotals", () => {
  it("groups by wallet, sorts by XP, and totals the season", () => {
    const t = 1_700_006_400;
    const board = buildLeaderboard([
      play({ wallet: "big", ts: t, costWad: 50n * WAD }),
      play({ wallet: "big", ts: t + 60, costWad: 50n * WAD }),
      play({ wallet: "small", ts: t, costWad: 1n * WAD }),
    ]);
    expect(board.map((e) => e.wallet)).toEqual(["big", "small"]);
    expect(board[0].plays).toBe(2);
    expect(board[0].level).toBeGreaterThanOrEqual(1);
    expect(board[0].rank).toBe("Rookie");

    const totals = seasonTotals(board);
    expect(totals).toEqual({
      totalPlays: 3,
      totalVolume: 101,
      activeWallets: 2,
    });
  });
});
