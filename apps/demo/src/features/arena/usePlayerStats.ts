// The one merged stats source for the player's numbers.
//
// Three ledgers can describe the same person: the arena server's profile,
// the device-local guest ledger, and the wallet's on-chain season score.
// The merge rule is a single comparison — chain wins when its season XP
// total beats the service/local base — and the winner supplies level, XP
// progress, plays AND streak together. Mixing plays from one ledger with
// XP from another would show a person who does not exist.
//
// Tickets, handle and the daily-claim marker are the social economy: they
// exist only on the server (or this device) and are never chain-derived.
//
// The navbar XP pill, the player card drawer and the arena sidecar all
// render from this hook, so they can never disagree.

import { useArenaPlayer } from "./ArenaPlayerProvider";
import { useSeasonLeaderboard } from "./useSeasonLeaderboard";
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

  const baseXp = profile?.xp ?? localXp;
  const chainWins = chainScore !== null && chainScore.xp > baseXp;
  const xp = chainWins ? chainScore.xp : baseXp;
  return {
    isSynced: profile !== null,
    handle: profile?.handle ?? null,
    xp,
    streak: chainWins ? chainScore.streakDays : (profile?.streak ?? localStreak),
    tickets: profile?.tickets ?? localTickets,
    plays: chainWins ? chainScore.plays : (profile?.plays ?? localPlays),
    lastDailyClaim: profile?.lastDailyClaim ?? localDailyClaim,
    level: levelFromXp(xp),
    levelProgress: levelProgressFromXp(xp),
  };
}
