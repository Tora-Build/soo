// The season is a protocol-level fact, defined once. Everything that says
// "S01" or "Reality Rush" — the navbar badge, the pulse panel, the
// leaderboard fold — renders from this object, so opening S02 is a one-line
// change here rather than a string hunt.

export const SEASON = {
  id: "S01",
  name: "Reality Rush",
  /** Season genesis: 2026-08-18T00:00:00Z, the day the current deployment's
   *  markets were seeded. Plays before this stay on the cached tape (past
   *  seasons remain recomputable) but score nothing in this season. */
  startTs: 1787011200,
  /** Season close: 2026-09-30T00:00:00Z. A season without an end is not a
   *  season — it is a label. Nothing settles at this instant on-chain; what
   *  changes is that the leaderboard stops moving, so the standings people
   *  spent six weeks climbing become a final result rather than a number
   *  that keeps drifting. Plays after it still trade normally and still earn
   *  the trader money; they just score nothing for S01. */
  endTs: 1790726400,
} as const;

/** Seconds. Injected in tests; `Date.now()` everywhere else. */
export const seasonNow = (): number => Math.floor(Date.now() / 1000);

export const isSeasonOver = (now: number = seasonNow()): boolean =>
  now >= SEASON.endTs;

/** Whole seconds left, floored at zero. */
export const seasonSecondsLeft = (now: number = seasonNow()): number =>
  Math.max(0, SEASON.endTs - now);

/**
 * "6d 4h" / "3h 20m" / "18m" — coarse on purpose.
 *
 * A season measured to the second reads as a countdown to a rocket launch.
 * The unit shrinks as the deadline approaches, so the display gets more
 * precise exactly when precision starts to matter.
 */
export function formatSeasonLeft(now: number = seasonNow()): string {
  const left = seasonSecondsLeft(now);
  if (left <= 0) return "ended";
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** The market-seeding / graduation operator wallets. Their trades are real
 *  market activity — they stay in season plays and volume — but the house
 *  does not compete: these wallets never take a ranked leaderboard slot. */
export const HOUSE_WALLETS = new Set([
  "7sEgHcMYhbrkZdiSP2rhVWqj3ydYv14ejyEw1E2UNniY",
  "64kyoszp9nni1Sy9aUPws7aXtVzbWNHkvV2U2iD8VPFE",
]);

export const isHouseWallet = (wallet: string) => HOUSE_WALLETS.has(wallet);
