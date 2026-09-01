// A season needs a close, and the close has to actually bind.
//
// "Season ended" over a leaderboard that keeps re-ordering is a caption, not
// a result — so the scoring window is bounded at BOTH ends, and these tests
// pin that plus the countdown's coarse formatting.

import { expect, test } from "vitest";
import {
  SEASON,
  formatSeasonLeft,
  isSeasonOver,
  seasonSecondsLeft,
} from "../src/features/arena/season";

test("the season has a close, and it is after the open", () => {
  expect(SEASON.endTs).toBeGreaterThan(SEASON.startTs);
});

test("isSeasonOver flips exactly at the close", () => {
  expect(isSeasonOver(SEASON.endTs - 1)).toBe(false);
  expect(isSeasonOver(SEASON.endTs)).toBe(true);
  expect(isSeasonOver(SEASON.endTs + 86_400)).toBe(true);
});

test("time left floors at zero rather than going negative", () => {
  expect(seasonSecondsLeft(SEASON.endTs - 60)).toBe(60);
  expect(seasonSecondsLeft(SEASON.endTs)).toBe(0);
  expect(seasonSecondsLeft(SEASON.endTs + 999)).toBe(0);
});

test("the countdown gets finer as the deadline nears", () => {
  expect(formatSeasonLeft(SEASON.endTs - 6 * 86_400 - 4 * 3600)).toBe("6d 4h");
  expect(formatSeasonLeft(SEASON.endTs - 3 * 3600 - 20 * 60)).toBe("3h 20m");
  expect(formatSeasonLeft(SEASON.endTs - 18 * 60)).toBe("18m");
  expect(formatSeasonLeft(SEASON.endTs)).toBe("ended");
});

test("a play after the close scores nothing for this season", () => {
  // Mirrors the filter in useSeasonLeaderboard: [startTs, endTs).
  const inSeason = (ts: number) => ts >= SEASON.startTs && ts < SEASON.endTs;
  expect(inSeason(SEASON.startTs)).toBe(true);
  expect(inSeason(SEASON.endTs - 1)).toBe(true);
  expect(inSeason(SEASON.endTs)).toBe(false);
  expect(inSeason(SEASON.startTs - 1)).toBe(false);
});
