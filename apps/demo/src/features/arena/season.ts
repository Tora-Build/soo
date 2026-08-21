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
} as const;

/** The market-seeding / graduation operator wallets. Their trades are real
 *  market activity — they stay in season plays and volume — but the house
 *  does not compete: these wallets never take a ranked leaderboard slot. */
export const HOUSE_WALLETS = new Set([
  "7sEgHcMYhbrkZdiSP2rhVWqj3ydYv14ejyEw1E2UNniY",
  "64kyoszp9nni1Sy9aUPws7aXtVzbWNHkvV2U2iD8VPFE",
]);

export const isHouseWallet = (wallet: string) => HOUSE_WALLETS.has(wallet);
