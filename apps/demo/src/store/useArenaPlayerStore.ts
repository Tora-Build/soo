// Local player progress for Arena.
//
// The arena server (VITE_ARENA_API_BASE) is the authority on XP, streaks and
// tickets whenever it is reachable. This store is the device-local ledger the
// HUD falls back to when it is not: it persists to localStorage, so a guest
// still sees a level, a streak and a filling XP bar instead of a dead HUD.
//
// Invariant: nothing here touches the chain. Playing a market is recorded by
// address string only, and the same market never awards the "new market"
// bonus twice.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ArenaOutcome = "yes" | "no" | "watch";

interface ArenaPick {
  market: string;
  outcome: ArenaOutcome;
  playedAt: number;
}

interface ArenaPlayerState {
  xp: number;
  streak: number;
  tickets: number;
  scoutedMarkets: string[];
  recentPicks: ArenaPick[];
  lastDailyClaim: string | null;
  /** Records a play and returns the XP awarded. */
  playMarket: (market: string, outcome?: ArenaOutcome) => number;
  /** Awards the daily drop once per calendar day; false if already claimed. */
  claimDailyDrop: () => boolean;
}

const todayKey = () => new Date().toISOString().slice(0, 10);

export const useArenaPlayerStore = create<ArenaPlayerState>()(
  persist(
    (set, get) => ({
      xp: 860,
      streak: 4,
      tickets: 3,
      scoutedMarkets: [],
      recentPicks: [],
      lastDailyClaim: null,
      playMarket: (market, outcome = "watch") => {
        const normalized = market.toLowerCase();
        const isNew = !get().scoutedMarkets.includes(normalized);
        const gainedXp = isNew ? 120 : 10;

        set((state) => ({
          xp: state.xp + gainedXp,
          scoutedMarkets: isNew
            ? [...state.scoutedMarkets, normalized]
            : state.scoutedMarkets,
          recentPicks: [
            { market: normalized, outcome, playedAt: Date.now() },
            ...state.recentPicks,
          ].slice(0, 12),
        }));

        return gainedXp;
      },
      claimDailyDrop: () => {
        const today = todayKey();
        if (get().lastDailyClaim === today) return false;

        set((state) => ({
          xp: state.xp + 250,
          tickets: state.tickets + 1,
          lastDailyClaim: today,
        }));
        return true;
      },
    }),
    {
      name: "sooth:arena-player:v1",
      partialize: (state) => ({
        xp: state.xp,
        streak: state.streak,
        tickets: state.tickets,
        scoutedMarkets: state.scoutedMarkets,
        recentPicks: state.recentPicks,
        lastDailyClaim: state.lastDailyClaim,
      }),
    },
  ),
);

/** XP per level. Level 1 spans 0–999 XP. */
export const XP_PER_LEVEL = 1_000;

export const levelFromXp = (xp: number) => Math.floor(xp / XP_PER_LEVEL) + 1;
export const levelProgressFromXp = (xp: number) => xp % XP_PER_LEVEL;

/** Season ladder. The index a level has reached is the player's current rank. */
export const ARENA_RANKS = ["Rookie", "Scout", "Oracle", "Legend"] as const;

export const rankIndexFromLevel = (level: number) =>
  level >= 12 ? 3 : level >= 6 ? 2 : level >= 2 ? 1 : 0;
