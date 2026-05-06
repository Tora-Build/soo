// chain-shim/portfolio-bridge.ts — routes the Portfolio page's wagmi-shim
// reads to real `SolanaChainAdapter` calls.
//
// Portfolio uses three load-bearing reads:
//
//   1. `LaunchpadEngine.getMarkets()` (in `useOnChainMarkets`) — returns the
//      array of all market addresses on the chain. We fan out to the
//      single seeded market PDA exposed via `DemoContext.marketRef`. Returning
//      `[<marketRef>]` lets `useActivePositions` walk a non-empty list.
//
//   2. `LAUNCHPAD_MARKET_ABI.{isSettled,winningOutcome,price,...}` and
//      `TruthMarket.{questionHash,isSettled,winningOutcome}` — per-market
//      reads upstream's `useOnChainMarkets` and `useActivePositions` issue
//      against the market address. Solana doesn't have separate
//      LaunchpadMarket / TruthMarket / outcome-token contracts; the AMM-
//      backed portfolio surface is the union of `Market` (lifecycle/deadline)
//      and `Position` (yes/no shares) PDAs. We translate to those.
//
//   3. `AMMEngine.getPosition(market, user)` — already routed via amm-bridge.
//      Falls through this dispatcher unchanged.
//
// The portfolio-bridge runs *before* the amm-bridge in `wagmi-shim.ts`'s
// dispatch chain (see comment at the dispatch site). Function names that
// neither bridge claims fall through to the existing sentinel return.
//
// LP-positions / locked-funds / claimable surfaces are intentionally
// "graceful empty": positions render an empty state and the Portfolio page
// still displays the user's AMM positions correctly.

import { yesPriceWad, type SolanaChainAdapter } from "@sooth/sdk-solana";
import type { ReadCallShape } from "./amm-bridge";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PortfolioBridgeCtx {
  adapter: SolanaChainAdapter;
  // The set of market refs the demo knows about. For now this is a single
  // entry seeded from `demoConfig.marketRef` (or DemoOverride.marketRef in
  // tests) — a fan-out list that grows when a real market registry lands.
  knownMarkets: readonly string[];
}

export const PORTFOLIO_NOT_HANDLED = Symbol("portfolio-bridge-not-handled");

// ─── Read dispatcher ────────────────────────────────────────────────────────

/**
 * Route a single read. Returns `PORTFOLIO_NOT_HANDLED` when the call is not
 * portfolio-shaped — caller should try the AMM bridge next.
 */
export async function dispatchPortfolioRead(
  call: ReadCallShape,
  ctx: PortfolioBridgeCtx,
): Promise<unknown | typeof PORTFOLIO_NOT_HANDLED> {
  const fn = call.functionName;
  if (!fn) return PORTFOLIO_NOT_HANDLED;

  switch (fn) {
    case "getMarkets": {
      // LaunchpadEngine.getMarkets() → readonly Address[]. The Solana
      // analogue is the seeded market PDA (single-element today). Return
      // the list shaped as `0x<base58>` strings so the EVM-typed
      // `useOnChainMarkets` pipeline accepts them. The amm-bridge's
      // `toMarketRef` accepts the `0x` prefix and unwraps it correctly.
      return ctx.knownMarkets.map((ref) => marketRefToEvmAddr(ref));
    }

    case "getMarketCount": {
      return BigInt(ctx.knownMarkets.length);
    }

    case "isGraduated": {
      // AMM-only fork — markets never graduate to a SoothBook orderbook.
      // The non-graduated branch in `useActivePositions` reads outcome-
      // token balances + AMM position, which is the path we want.
      return false;
    }

    case "isSettled": {
      // Read lifecycle from the Market PDA. Lifecycle.Settled iff settled.
      const marketRef = pickMarketRef(call, ctx);
      if (!marketRef) return false;
      try {
        const snap = await ctx.adapter.readSnapshot(marketRef);
        return Boolean(snap.market.isSettled);
      } catch {
        return false;
      }
    }

    case "winningOutcome": {
      const marketRef = pickMarketRef(call, ctx);
      if (!marketRef) return 0;
      try {
        const snap = await ctx.adapter.readSnapshot(marketRef);
        // Solana adapter exposes `outcome` only when settled.
        return Number(snap.market.outcome ?? 0);
      } catch {
        return 0;
      }
    }

    case "questionHash": {
      // The on-chain Market stores a 32-byte question hash. Return as a
      // 0x-prefixed hex string. `useOnChainMarkets` only checks truthiness.
      const marketRef = pickMarketRef(call, ctx);
      if (!marketRef) return "0x" + "00".repeat(32);
      try {
        const snap = await ctx.adapter.readSnapshot(marketRef);
        // adapter encodes question as `0x<hex>`. Return as-is.
        return snap.market.question;
      } catch {
        return "0x" + "00".repeat(32);
      }
    }

    case "price": {
      // LAUNCHPAD_MARKET_ABI.price(outcome) → uint256 in WAD.
      // Read AMM state and compute LMSR yes-price; route by outcome arg.
      const marketRef = pickMarketRef(call, ctx);
      if (!marketRef) return 5n * 10n ** 17n;
      const outcome = Number(call.args?.[0] ?? 0);
      try {
        const snap = await ctx.adapter.readSnapshot(marketRef);
        const yesP = yesPriceWad(
          snap.market.qYes,
          snap.market.qNo,
          snap.market.b,
        );
        return outcome === 1 ? yesP : 10n ** 18n - yesP;
      } catch {
        return 5n * 10n ** 17n;
      }
    }

    // ─── LP / Vault / Locked-funds — graceful zero ──────────────────────
    // NOTE: `totalSupply` was previously handled here as a graceful zero;
    // it now falls through to the markets-bridge so MarketStats's LP-supply
    // dependent math (floorRate/ceilingRate) gets a synthetic anchor value.
    case "totalAssets":
    case "totalNetAssets":
    case "ammAssets":
    case "pureCeilingAssets":
    case "graduationThreshold":
    case "lockedProceeds":
    case "lockedBalance":
    case "claimableBalance":
    case "totalLockedProceeds":
      return 0n;

    case "isLive": {
      const marketRef = pickMarketRef(call, ctx);
      if (!marketRef) return false;
      try {
        const snap = await ctx.adapter.readSnapshot(marketRef);
        return Boolean(snap.market.isLive);
      } catch {
        return false;
      }
    }

    case "isUnderwater":
    case "isLiquidated":
      return false;

    case "deadline": {
      const marketRef = pickMarketRef(call, ctx);
      if (!marketRef) return 0n;
      try {
        const snap = await ctx.adapter.readSnapshot(marketRef);
        return snap.market.deadline;
      } catch {
        return 0n;
      }
    }

    case "creator":
    case "factory":
    case "outcomeToken":
    case "adjudicator":
      // Solana has no separate creator/factory/adjudicator contract — return
      // zero address so upstream's `!== ZERO_ADDRESS` gates short-circuit.
      return "0x0000000000000000000000000000000000000000";

    case "tStar":
      return 0n;

    case "getLockEntries":
      return [[], []] as const;

    default:
      return PORTFOLIO_NOT_HANDLED;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Translate a Solana `sol:<base58>` ref into the EVM-typed `0x<base58>`
 * placeholder upstream code expects in its address slots. The amm-bridge's
 * `toMarketRef` strips the `0x` and re-prepends `sol:`, so this is the
 * inverse round-trip.
 */
function marketRefToEvmAddr(ref: string): `0x${string}` {
  const tail = ref.replace(/^sol:/, "");
  return ("0x" + tail) as `0x${string}`;
}

/**
 * Most per-market reads carry the market address as `call.address` (a single
 * `0x<base58>` slot, not in `args`). Decode that into a Solana market ref
 * for the adapter. Returns undefined when the address slot is absent or
 * doesn't resolve to a known market — the portfolio-bridge degrades to the
 * empty-state in that case rather than throwing.
 */
function pickMarketRef(
  call: ReadCallShape,
  ctx: PortfolioBridgeCtx,
): string | undefined {
  const v = call.address;
  if (typeof v !== "string" || !v) return undefined;
  // `0x<base58>` — drop the prefix, prepend `sol:`.
  if (v.startsWith("0x")) {
    const tail = v.slice(2);
    if (!tail) return undefined;
    const ref = `sol:${tail}`;
    // Sanity: only return when the ref matches one of the known markets.
    // Stops cross-talk where a per-engine-address read (e.g. AMMEngine) is
    // accidentally treated as a market read.
    if (ctx.knownMarkets.includes(ref)) return ref;
    return undefined;
  }
  if (v.startsWith("sol:")) return v;
  return undefined;
}
