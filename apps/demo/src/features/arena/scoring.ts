// Chain-derived arena scoring. Pure functions only — the input is the play
// tape `readMarketPlays` decodes off devnet transactions, and the output is
// the season leaderboard. No server, no database: the chain is the
// scoreboard, and any client folding the same tape gets the same board.
//
// The progression curve follows the shape of established game XP systems:
// a steady base gain per play, a bonus that scales with commitment but caps
// before whales own the board, a discovery bonus for entering a new market,
// and a daily-streak multiplier that rewards showing up.
//
// Levels and ranks are NOT redefined here — they import from the local
// player store so a chain-scored wallet and a guest ledger climb the exact
// same ladder.

import {
  ARENA_RANKS,
  levelFromXp,
  rankIndexFromLevel,
} from "../../store/useArenaPlayerStore";

/** One scored play: a wallet moving money on a market, as decoded from a
 *  `PositionTraded` / `PositionSold` / `OrdersFilled` event. */
export interface ChainPlay {
  wallet: string;
  market: string;
  venue: "amm" | "book";
  role?: "taker" | "maker";
  /** Shares in WAD. */
  sizeWad: bigint;
  /** USDC notional in WAD, when the event carries one. */
  costWad?: bigint;
  /** Unix seconds. */
  ts: number;
  signature: string;
}

export interface WalletScore {
  wallet: string;
  xp: number;
  level: number;
  rank: (typeof ARENA_RANKS)[number];
  plays: number;
  /** Total USDC notional across plays, in whole-number USDC. */
  volumeUsdc: number;
  /** Consecutive-UTC-day run ending at the wallet's most recent play day. */
  streakDays: number;
  lastPlayTs: number;
}

export interface SeasonTotals {
  totalPlays: number;
  totalVolume: number;
  activeWallets: number;
}

/** Every play lands this much before bonuses. */
export const BASE_PLAY_XP = 100;
/** +1 XP per whole USDC of notional, capped so one whale trade ≈ 2.5 plays. */
export const SIZE_BONUS_CAP_XP = 150;
/** First play a wallet makes in a market it has never touched. */
export const DISCOVERY_BONUS_XP = 50;

const WAD = 10n ** 18n;
const SECONDS_PER_DAY = 86_400;

/** The play's USDC notional, floored to whole dollars. Falls back to share
 *  count when the event carries no cost — shares are WAD like cost, so the
 *  fallback stays in the same order of magnitude. */
export const playNotionalUsdc = (play: Pick<ChainPlay, "sizeWad" | "costWad">) =>
  Number((play.costWad ?? play.sizeWad) / WAD);

/** +1 XP per whole USDC, capped at {@link SIZE_BONUS_CAP_XP}. */
export const sizeBonusXp = (play: Pick<ChainPlay, "sizeWad" | "costWad">) =>
  Math.min(SIZE_BONUS_CAP_XP, Math.max(0, playNotionalUsdc(play)));

/** Daily-streak multiplier: 1 day ×1.0, 2 ×1.1, 3–6 ×1.25, 7+ ×1.5. */
export const streakMultiplier = (streakDays: number) =>
  streakDays >= 7 ? 1.5 : streakDays >= 3 ? 1.25 : streakDays >= 2 ? 1.1 : 1.0;

/** UTC day ordinal for a unix-seconds timestamp. */
export const utcDayOf = (ts: number) => Math.floor(ts / SECONDS_PER_DAY);

/**
 * Folds one wallet's plays (any order) into its score.
 *
 * Per play: `(base + size bonus + discovery bonus) × streak multiplier`,
 * floored. The streak counts consecutive UTC days with at least one play,
 * and the multiplier a play earns is the streak length as of that play's
 * day — day one of a comeback scores ×1.0 even after a long historical run.
 */
export function scoreWallet(wallet: string, plays: ChainPlay[]): WalletScore {
  const ordered = [...plays].sort((a, b) => a.ts - b.ts);
  const seenMarkets = new Set<string>();
  let xp = 0;
  let volumeUsdc = 0;
  let streakDays = 0;
  let lastDay = Number.NEGATIVE_INFINITY;

  for (const play of ordered) {
    const day = utcDayOf(play.ts);
    if (day !== lastDay) {
      streakDays = day === lastDay + 1 ? streakDays + 1 : 1;
      lastDay = day;
    }

    const market = play.market.toLowerCase();
    const discovery = seenMarkets.has(market) ? 0 : DISCOVERY_BONUS_XP;
    seenMarkets.add(market);

    xp += Math.floor(
      (BASE_PLAY_XP + sizeBonusXp(play) + discovery) *
        streakMultiplier(streakDays),
    );
    volumeUsdc += playNotionalUsdc(play);
  }

  const level = levelFromXp(xp);
  return {
    wallet,
    xp,
    level,
    rank: ARENA_RANKS[rankIndexFromLevel(level)],
    plays: ordered.length,
    volumeUsdc,
    streakDays,
    lastPlayTs: ordered.length ? ordered[ordered.length - 1].ts : 0,
  };
}

/**
 * The season board: every wallet on the tape, scored and sorted by XP
 * (ties broken by most recent play, then wallet for determinism).
 */
export function buildLeaderboard(plays: ChainPlay[]): WalletScore[] {
  const byWallet = new Map<string, ChainPlay[]>();
  for (const play of plays) {
    const list = byWallet.get(play.wallet);
    if (list) list.push(play);
    else byWallet.set(play.wallet, [play]);
  }
  return [...byWallet.entries()]
    .map(([wallet, walletPlays]) => scoreWallet(wallet, walletPlays))
    .sort(
      (a, b) =>
        b.xp - a.xp || b.lastPlayTs - a.lastPlayTs ||
        a.wallet.localeCompare(b.wallet),
    );
}

/** Season-wide aggregates for the pulse panel. */
export function seasonTotals(board: WalletScore[]): SeasonTotals {
  return {
    totalPlays: board.reduce((sum, entry) => sum + entry.plays, 0),
    totalVolume: board.reduce((sum, entry) => sum + entry.volumeUsdc, 0),
    activeWallets: board.length,
  };
}
