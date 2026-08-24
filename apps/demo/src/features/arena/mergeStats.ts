// The one merge rule for the player's numbers, as a pure function.
//
// Three ledgers can describe the same person, and two of them score the SAME
// events: the chain tape and the server's confirmed-play endpoint both award
// XP for a trade, so adding them would pay every play twice. The daily drop
// is different — it exists only on the server (or this device), and no chain
// event mirrors it.
//
// So the rule is: PLAY XP is a maximum, SOCIAL XP is a sum on top.
//
//   xp = max(chain play XP, ledger play XP) + drops
//
// The previous rule was a plain maximum over the mixed totals, which meant a
// wallet whose chain XP exceeded its server XP could claim a daily drop and
// watch the number not move — the +250 landed on the ledger the maximum had
// already discarded. A reward that does not change the number it promises to
// change reads as a broken game, because it is one.

export interface MergeInput {
  /** Server profile, when synced. */
  profile: {
    xp: number;
    socialXp?: number;
    playsXp?: number;
    streak: number;
    plays: number;
    tickets: number;
  } | null;
  /** Chain-derived season score, when the wallet has plays on the tape. */
  chain: { xp: number; streakDays: number; plays: number } | null;
  /** Device-local guest ledger (mixed: plays + drops). */
  local: { xp: number; streak: number; plays: number; tickets: number };
}

export interface MergedStats {
  xp: number;
  streak: number;
  plays: number;
  tickets: number;
}

export function mergeStats({ profile, chain, local }: MergeInput): MergedStats {
  const chainXp = chain?.xp ?? 0;

  if (profile) {
    // An older server that has not split its ledger reports only the mixed
    // total; treating it all as play XP keeps the old maximum-rule behaviour
    // rather than double counting drops it cannot identify.
    const social = profile.socialXp ?? 0;
    const playBase = profile.playsXp ?? profile.xp;
    return {
      xp: Math.max(chainXp, playBase) + social,
      // Streak rewards showing up — a play OR a claim extends it, so the
      // widest honest measure of "showing up" wins.
      streak: Math.max(chain?.streakDays ?? 0, profile.streak),
      plays: Math.max(chain?.plays ?? 0, profile.plays),
      tickets: profile.tickets,
    };
  }

  // Guest: the local ledger mixes plays and drops with no split, so the old
  // maximum rule is the best available without inventing a decomposition.
  const chainWins = chain !== null && chain.xp > local.xp;
  return {
    xp: chainWins ? chain.xp : local.xp,
    streak: chainWins ? chain.streakDays : local.streak,
    plays: chainWins ? chain.plays : local.plays,
    tickets: local.tickets,
  };
}
