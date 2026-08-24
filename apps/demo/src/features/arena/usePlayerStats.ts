// The one merged stats source for the player's numbers.
//
// The merge itself lives in mergeStats.ts as a pure function — play XP is a
// maximum across ledgers that score the same trades, social XP (daily drops)
// is a sum on top, because no other ledger mirrors it. This hook only wires
// the three ledgers in.
//
// The navbar XP pill, the player card drawer and the arena sidecar all
// render from this hook, so they can never disagree.

import { useArenaPlayer } from "./ArenaPlayerProvider";
import { useSeasonLeaderboard } from "./useSeasonLeaderboard";
import { mergeStats } from "./mergeStats";
import {
  levelFromXp,
  levelProgressFromXp,
  useArenaPlayerStore,
} from "../../store/useArenaPlayerStore";

export function usePlayerStats() {
  const { profile } = useArenaPlayer();
  const { you: chainScore } = useSeasonLeaderboard();
  const localXp = useArenaPlayerStore((s) => s.xp);
  const localStreak = useArenaPlayerStore((s) => s.streak);
  const localTickets = useArenaPlayerStore((s) => s.tickets);
  const localPlays = useArenaPlayerStore((s) => s.scoutedMarkets.length);
  const localDailyClaim = useArenaPlayerStore((s) => s.lastDailyClaim);

  const merged = mergeStats({
    profile,
    chain: chainScore,
    local: {
      xp: localXp,
      streak: localStreak,
      plays: localPlays,
      tickets: localTickets,
    },
  });

  return {
    isSynced: profile !== null,
    handle: profile?.handle ?? null,
    xp: merged.xp,
    streak: merged.streak,
    tickets: merged.tickets,
    plays: merged.plays,
    lastDailyClaim: profile?.lastDailyClaim ?? localDailyClaim,
    level: levelFromXp(merged.xp),
    levelProgress: levelProgressFromXp(merged.xp),
  };
}
