// The season leaderboard, derived entirely from on-chain events.
//
// Fans `readMarketPlays` out across every known market and folds the plays
// through `scoring.ts`. No server, no database: the chain is the scoreboard.
//
// The RPC is proxied and moderately slow, so this never re-walks history on
// a poll. Each market keeps an `until` cursor (the newest signature already
// decoded) and its play tape in localStorage; a poll costs one signature
// listing per market plus one `getTransaction` per NEW transaction. The
// cached tape also hydrates the board synchronously on page load, so the UI
// shows the last known season while the first refresh runs.
//
// One fetch loop feeds every mount (Navbar's XP pill and the arena sidecar
// render from the same store), keyed by a refcount so the interval exists
// exactly once.

import { useContext, useEffect, useMemo } from "react";
import { create } from "zustand";
import type { SolanaChainAdapter } from "@sooth/sdk-solana";
import { DemoContextObj } from "../../lib/DemoContext";
import { demoConfig } from "../../lib/config";
import {
  buildLeaderboard,
  seasonTotals,
  type ChainPlay,
  type SeasonTotals,
  type WalletScore,
} from "./scoring";
import { SEASON, isHouseWallet } from "./season";

// ─── Persistent per-market cache ────────────────────────────────────────────

/** Bump to discard tapes cached under an older play shape or scoring input. */
import seasonSnapshot from "./season-snapshot.json";

const CACHE_KEY = "sooth:arena:chain-plays:v1";
const POLL_MS = 60_000;
/** Deepest first walk per market — beyond this the tape starts mid-history,
 *  which is still an honest leaderboard of recent play. */
const FIRST_WALK_LIMIT = 300;

interface SerializedPlay {
  wallet: string;
  venue: "amm" | "book";
  role?: "taker" | "maker";
  sizeWad: string;
  costWad?: string;
  ts: number;
  signature: string;
}

interface MarketCache {
  cursor?: string;
  plays: SerializedPlay[];
}

type PlaysCache = Record<string, MarketCache>;

function loadCache(): PlaysCache {
  // The bundled snapshot is the floor: a cold browser hydrates the whole
  // season tape without touching the RPC, then polls only past each
  // market's cursor. A market the browser has walked itself supersedes its
  // snapshot entry — the local tape extends the same history.
  const base = { ...(seasonSnapshot.markets as PlaysCache) };
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as PlaysCache;
    if (!parsed || typeof parsed !== "object") return base;
    for (const [market, entry] of Object.entries(parsed)) {
      const snap = base[market];
      if (!snap || entry.plays.length >= snap.plays.length) {
        base[market] = entry;
      }
    }
    return base;
  } catch {
    return base;
  }
}

function saveCache(cache: PlaysCache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Quota or private-mode failure — the board still works, it just
    // re-walks history on the next load.
  }
}

function toChainPlays(market: string, plays: SerializedPlay[]): ChainPlay[] {
  return plays.map((p) => ({
    wallet: p.wallet,
    market,
    venue: p.venue,
    role: p.role,
    sizeWad: BigInt(p.sizeWad),
    costWad: p.costWad === undefined ? undefined : BigInt(p.costWad),
    ts: p.ts,
    signature: p.signature,
  }));
}

/** Every market the demo can see: the seeded ref, the env extras, and any
 *  PDA a create flow persisted (same stores the chain-shim's registry-less
 *  discovery reads — there is no on-chain registry to ask instead). */
function knownMarketRefs(): string[] {
  const refs = new Set<string>();
  if (demoConfig.marketRef) refs.add(demoConfig.marketRef);
  for (const ref of demoConfig.extraMarketRefs) refs.add(ref);
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem("__soothCreatedMarketPdas");
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const pda of parsed) {
          if (typeof pda === "string" && pda) refs.add(`sol:${pda}`);
        }
      }
    } catch {
      // Unreadable storage is not a reason to lose the env-configured refs.
    }
  }
  return [...refs];
}

// ─── Store + fetch loop ─────────────────────────────────────────────────────

interface SeasonState {
  /** Ranked competitors only — house wallets never hold a board position. */
  board: WalletScore[];
  /** House (operator) wallets' scores, listed apart from the ranking. */
  house: WalletScore[];
  season: SeasonTotals;
  /** False once the board reflects at least one completed chain read. */
  hasLoaded: boolean;
  isFetching: boolean;
}

function boardFromCache(
  cache: PlaysCache,
): Pick<SeasonState, "board" | "house" | "season"> {
  const plays: ChainPlay[] = [];
  for (const [market, entry] of Object.entries(cache)) {
    plays.push(...toChainPlays(market, entry.plays ?? []));
  }
  // The cache keeps the full tape; the season is a fold-time window, so past
  // seasons stay recomputable from the same cache.
  const seasonPlays = plays.filter((p) => p.ts >= SEASON.startTs);
  const full = buildLeaderboard(seasonPlays);
  const board = full.filter((entry) => !isHouseWallet(entry.wallet));
  const house = full.filter((entry) => isHouseWallet(entry.wallet));
  // House trades are real market activity — plays and volume count them.
  // The wallet count is the field of competitors, so it does not.
  const totals = seasonTotals(full);
  return {
    board,
    house,
    season: { ...totals, activeWallets: board.length },
  };
}

const useSeasonStore = create<SeasonState>(() => {
  // Hydrate synchronously from the cached tape — stale beats blank.
  const cached = loadCache();
  const hasCached = Object.keys(cached).length > 0;
  return {
    ...boardFromCache(cached),
    hasLoaded: hasCached,
    isFetching: false,
  };
});

let activeAdapter: SolanaChainAdapter | null = null;
let inFlight: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let mountCount = 0;

async function fetchSeason(): Promise<void> {
  const adapter = activeAdapter;
  if (!adapter) return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    useSeasonStore.setState({ isFetching: true });
    const cache = loadCache();
    let changed = false;
    for (const ref of knownMarketRefs()) {
      const entry: MarketCache = cache[ref] ?? { plays: [] };
      try {
        const { plays, latestSignature } = await adapter.readMarketPlays(ref, {
          limit: FIRST_WALK_LIMIT,
          until: entry.cursor,
        });
        if (plays.length > 0) {
          entry.plays = [
            ...entry.plays,
            ...plays.map((p) => ({
              wallet: p.wallet,
              venue: p.venue,
              role: p.role,
              sizeWad: p.sizeWad.toString(),
              costWad: p.costWad?.toString(),
              ts: p.ts,
              signature: p.signature,
            })),
          ];
          changed = true;
        }
        if (latestSignature && latestSignature !== entry.cursor) {
          entry.cursor = latestSignature;
          changed = true;
        }
        cache[ref] = entry;
      } catch {
        // One market failing to read (rate limit, transient RPC error) must
        // not lose the others — keep its cursor where it was and move on.
      }
    }
    if (changed) saveCache(cache);
    useSeasonStore.setState({
      ...boardFromCache(cache),
      hasLoaded: true,
      isFetching: false,
    });
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Kicks an immediate refetch — called right after the user's own trade
 *  confirms, so their play lands on the board without waiting for the poll. */
export function refreshSeasonLeaderboard(): Promise<void> {
  return fetchSeason() ?? Promise.resolve();
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface SeasonLeaderboard {
  /** Sorted best-first; index 0 is rank #1. House wallets are not here. */
  leaders: WalletScore[];
  /** House wallets' season scores — shown, tagged, but never ranked. */
  house: WalletScore[];
  /** The connected wallet's score, with its 1-based board position. */
  you: (WalletScore & { position: number }) | null;
  season: SeasonTotals;
  /** True until the board reflects either a cache hit or a chain read. */
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useSeasonLeaderboard(): SeasonLeaderboard {
  const demo = useContext(DemoContextObj);
  const adapter = demo?.adapter ?? null;
  const wallet = demo?.userRef ? demo.userRef.replace(/^sol:/, "") : null;

  useEffect(() => {
    if (!adapter) return;
    activeAdapter = adapter;
    mountCount += 1;
    if (mountCount === 1) {
      void fetchSeason();
      pollTimer = setInterval(() => void fetchSeason(), POLL_MS);
    }
    return () => {
      mountCount -= 1;
      if (mountCount === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  }, [adapter]);

  const board = useSeasonStore((s) => s.board);
  const house = useSeasonStore((s) => s.house);
  const season = useSeasonStore((s) => s.season);
  const hasLoaded = useSeasonStore((s) => s.hasLoaded);

  const you = useMemo(() => {
    if (!wallet) return null;
    const index = board.findIndex((entry) => entry.wallet === wallet);
    if (index >= 0) return { ...board[index], position: index + 1 };
    // A connected house wallet still sees its own run — pinned after the
    // ranked field, where the house rows live.
    const houseIndex = house.findIndex((entry) => entry.wallet === wallet);
    if (houseIndex < 0) return null;
    return { ...house[houseIndex], position: board.length + houseIndex + 1 };
  }, [board, house, wallet]);

  return {
    leaders: board,
    house,
    you,
    season,
    isLoading: !hasLoaded,
    refresh: refreshSeasonLeaderboard,
  };
}
