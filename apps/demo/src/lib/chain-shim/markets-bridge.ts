// chain-shim/markets-bridge.ts — fills in market-list / Market-Stats reads
// the portfolio + amm bridges intentionally returned as graceful zero.
//
// Two integration points:
//
//   1. `getGraduationProgress(market)` — `FeeRouter.getGraduationProgress`
//      returns `(feesAccrued, threshold, progressBps)` upstream. The Solana
//      AMM has no separate FeeRouter contract or per-market fee accumulator
//      surfaced through `MarketInfo` yet; this bridge synthesizes a sensible
//      progress from `AmmState.q_yes/q_no/b`. The mapping:
//
//        threshold = b · ln(2)         (the LMSR max-loss anchor, in WAD)
//        progressBps = clamp(10000 · (qYes + qNo) / b, 0..9_999)
//        feesAccrued = 0n              (no on-chain accumulator exposed)
//
//      `progressBps` is capped at 9_999 (99.99%) so upstream never trips the
//      `progressBps >= 10000` "isEffectiveGraduated" branch from a bridged
//      read alone — graduation comes from the actual `AmmState.is_graduated`
//      flag, exposed through `isGraduated`.
//
//   2. `totalSupply()` — LP token total supply. Upstream reads this from
//      a per-market lpToken contract; the Solana fork doesn't deploy one.
//      We synthesize the LMSR anchor supply (`b · ln(2)`) for the single
//      seeded market so MarketStats's `floorRate / ceilingRate` divisions
//      don't degenerate to 0.
//
// Dispatch precedence (in `wagmi-shim.ts`): markets-bridge runs *after*
// the portfolio bridge but *before* the amm bridge. The portfolio bridge
// no longer claims `totalSupply` — that case fell out of its graceful-zero
// list specifically so this bridge can synthesize a non-zero LP supply.
// Function names this bridge doesn't recognize fall through unchanged.

import { WAD, LN2_WAD, type SolanaChainAdapter } from "@sooth/sdk-solana";
import type { ReadCallShape } from "./amm-bridge";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MarketsBridgeCtx {
  adapter: SolanaChainAdapter;
  // Same `knownMarkets` slot the portfolio bridge holds. Single-element
  // today; both bridges read it.
  knownMarkets: readonly string[];
}

export const MARKETS_NOT_HANDLED = Symbol("markets-bridge-not-handled");

// ─── Read dispatcher ────────────────────────────────────────────────────────

/**
 * Route a single read. Returns `MARKETS_NOT_HANDLED` for everything the
 * markets bridge doesn't claim — caller continues down the dispatch chain.
 */
export async function dispatchMarketsRead(
  call: ReadCallShape,
  ctx: MarketsBridgeCtx,
): Promise<unknown | typeof MARKETS_NOT_HANDLED> {
  const fn = call.functionName;
  if (!fn) return MARKETS_NOT_HANDLED;

  switch (fn) {
    case "getGraduationProgress": {
      // FeeRouter.getGraduationProgress(market) → (feesAccrued, threshold,
      // progressBps). The market address comes through args[0]; address slot
      // is the FeeRouter (an EVM hex), not the market PDA.
      const marketRef = pickMarketRefFromArgs(call, ctx);
      if (!marketRef) return [0n, 0n, 0n] as const;
      try {
        const snap = await ctx.adapter.readSnapshot(marketRef);
        const { qYes, qNo, b } = snap.market;
        if (b <= 0n) return [0n, 0n, 0n] as const;
        // Synthetic threshold = `b · ln(2)` in WAD. Upstream consumers
        // (`useLaunchpadMarketDirect`, `useAMMQuoteDirect`) only divide /
        // compare against this value — the absolute scale is irrelevant.
        const thresholdWad = (b * LN2_WAD) / WAD;
        // Activity proxy: total absolute shares scaled against `b`. A
        // freshly seeded market has qYes = qNo = 0 → 0 progress.
        const totalShares = absSum(qYes, qNo);
        // Floor at 1 to avoid divide-by-zero further downstream; cap at 9999.
        let progressBps = b > 0n ? (10_000n * totalShares) / b : 0n;
        if (progressBps > 9_999n) progressBps = 9_999n;
        return [0n, thresholdWad, progressBps] as const;
      } catch {
        return [0n, 0n, 0n] as const;
      }
    }

    case "totalSupply": {
      // ERC20 totalSupply on the synthetic LP token (see amm-bridge.markets()
      // — `lpToken` is a synthetic non-zero address there). Upstream reads
      // this to feed `MarketStats.floorRate / ceilingRate` divisions and
      // `useLaunchpadMarketDirect.lpSupply`. The LMSR anchor convention is
      // `LP supply ≈ b · ln(2)`; surfaced in WAD to match upstream's
      // `formatUnits(supply, 18)` rendering.
      //
      // Single-known-market shortcut: with one seeded market we read its
      // `b` and return `b · ln(2)`. When the demo grows a market registry
      // we'll switch this to an args-keyed lookup.
      const marketRef = ctx.knownMarkets[0];
      if (!marketRef) return 0n;
      try {
        const snap = await ctx.adapter.readSnapshot(marketRef);
        const { b } = snap.market;
        if (b <= 0n) return 0n;
        return (b * LN2_WAD) / WAD;
      } catch {
        return 0n;
      }
    }

    default:
      return MARKETS_NOT_HANDLED;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Decode the `args[0]` slot into a Solana market ref. Mirrors the helper
 * in portfolio-bridge but reads from `args` (FeeRouter and similar
 * per-market reads pass the market via the first arg, not the address slot).
 */
function pickMarketRefFromArgs(
  call: ReadCallShape,
  ctx: MarketsBridgeCtx,
): string | undefined {
  const v = call.args?.[0];
  if (typeof v !== "string" || !v) return undefined;
  if (v.startsWith("0x")) {
    const tail = v.slice(2);
    if (!tail) return undefined;
    const ref = `sol:${tail}`;
    if (ctx.knownMarkets.includes(ref)) return ref;
    return undefined;
  }
  if (v.startsWith("sol:")) {
    return ctx.knownMarkets.includes(v) ? v : undefined;
  }
  return undefined;
}

/** Sum of absolute values — guards qYes/qNo treating them as non-negative. */
function absSum(a: bigint, b: bigint): bigint {
  const aa = a < 0n ? -a : a;
  const bb = b < 0n ? -b : b;
  return aa + bb;
}
