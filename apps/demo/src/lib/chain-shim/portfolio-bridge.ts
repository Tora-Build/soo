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
import { toMarketRef, type ReadCallShape } from "./amm-bridge";
import { fallbackUnlessUnreachable } from "./rpc-errors";

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
      return allKnownMarketRefs(ctx).map((ref) => marketRefToEvmAddr(ref));
    }

    case "getMarketCount": {
      return BigInt(allKnownMarketRefs(ctx).length);
    }

    case "isGraduated": {
      // Reads the real AmmState flag.
      //
      // This used to return a hardcoded `false` with the note "AMM-only fork —
      // markets never graduate to a SoothBook orderbook". That was true when
      // written and is not any more: the orderbook exists. While the stub
      // stayed, `useOnChainMarkets` could never set `stage = "live"`, so no
      // market ever routed to /orderbook/:addr no matter what the chain said —
      // the orderbook was unreachable through the UI by construction.
      const marketRef = toMarketRef(call.args?.[0]);
      if (!marketRef) return false;
      try {
        const amm = await ctx.adapter.readAmmState(marketRef);
        return Boolean(amm?.isGraduated);
      } catch (err) {
        // A market with no AmmState is pre-launch, so `false` is the truth.
        //
        // An unreachable RPC is NOT. This value decides routing — a market
        // reading as not-graduated has no orderbook tab — so swallowing a
        // dead-chain error here makes the orderbook vanish with nothing on
        // screen explaining why. That is exactly what happened when the
        // validator was killed out from under a running dev server.
        return fallbackUnlessUnreachable(err, false);
      }
    }

    case "isSettled":
      return readMarketField(call, ctx, false, (m) => Boolean(m.isSettled));

    case "winningOutcome":
      // Solana adapter exposes `outcome` only when settled.
      return readMarketField(call, ctx, 0, (m) => Number(m.outcome ?? 0));

    case "questionHash":
      // The on-chain Market stores a 32-byte question hash. Return as a
      // 0x-prefixed hex string. `useOnChainMarkets` only checks truthiness.
      return readMarketField(
        call,
        ctx,
        "0x" + "00".repeat(32),
        (m) => m.question,
      );

    case "price": {
      // LAUNCHPAD_MARKET_ABI.price(outcome) → uint256 in WAD.
      // Read AMM state and compute LMSR yes-price; route by outcome arg.
      const outcome = Number(call.args?.[0] ?? 0);
      return readMarketField(call, ctx, 5n * 10n ** 17n, (m) => {
        const yesP = yesPriceWad(m.qYes, m.qNo, m.b);
        return outcome === 1 ? yesP : 10n ** 18n - yesP;
      });
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

    case "isLive":
      return readMarketField(call, ctx, false, (m) => Boolean(m.isLive));

    case "isUnderwater":
    case "isLiquidated":
      return false;

    case "deadline":
      return readMarketField(call, ctx, 0n, (m) => m.deadline);

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
 * Resolve the market PDA from `call`, fetch its snapshot, and pluck a field.
 * On any failure (missing market ref, RPC error, malformed account data) the
 * provided `fallback` is returned — every per-field branch in the dispatch
 * switch wants this exact shape, so single-sourcing keeps drift out and trims
 * ~6 try/catch blocks down to one-liner picks.
 */
async function readMarketField<T>(
  call: ReadCallShape,
  ctx: PortfolioBridgeCtx,
  fallback: T,
  pick: (
    m: Awaited<ReturnType<SolanaChainAdapter["readSnapshot"]>>["market"],
  ) => T,
): Promise<T> {
  const marketRef = pickMarketRef(call, ctx);
  if (!marketRef) return fallback;
  try {
    const snap = await ctx.adapter.readSnapshot(marketRef);
    return pick(snap.market);
  } catch {
    return fallback;
  }
}

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
  const known = allKnownMarketRefs(ctx);
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
    if (known.includes(ref)) return ref;
    return undefined;
  }
  if (v.startsWith("sol:")) return known.includes(v) ? v : undefined;
  return undefined;
}

function allKnownMarketRefs(ctx: PortfolioBridgeCtx): string[] {
  const refs = new Set(ctx.knownMarkets);
  const created = (
    globalThis as unknown as { __soothCreatedMarketPdas?: string[] }
  ).__soothCreatedMarketPdas;
  if (Array.isArray(created)) {
    for (const pda of created) {
      if (typeof pda === "string" && pda) refs.add(`sol:${pda}`);
    }
  }
  // Page-load survives via sessionStorage — `page.goto()` wipes window
  // globals, so the in-memory list is empty for navigations away from
  // the page that did createMarket. The amm-bridge persists every
  // created PDA there.
  // Both stores: sessionStorage survives navigation within a tab,
  // localStorage survives the tab closing. Without the second, a market you
  // created yesterday is unreachable — there is no on-chain registry to
  // rediscover it from, so a forgotten PDA is a lost market.
  for (const store of ["sessionStorage", "localStorage"] as const) {
    try {
      const s =
        store === "sessionStorage"
          ? typeof sessionStorage !== "undefined"
            ? sessionStorage
            : null
          : typeof localStorage !== "undefined"
            ? localStorage
            : null;
      if (!s) continue;
      const raw = s.getItem("__soothCreatedMarketPdas");
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const pda of parsed) {
          if (typeof pda === "string" && pda) refs.add(`sol:${pda}`);
        }
      }
    } catch {
      // Storage parse / access errors are non-fatal — fall through.
    }
  }
  return [...refs];
}
