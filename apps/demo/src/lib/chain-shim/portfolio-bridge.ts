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
import { PublicKey } from "@solana/web3.js";
import { getAccount, getMint } from "@solana/spl-token";
import { toMarketRef, type ReadCallShape } from "./amm-bridge";
import { fallbackUnlessUnreachable } from "./rpc-errors";

// ─── AMM finance — the real numbers behind the EVM accounting reads ─────────
//
// Upstream's LaunchpadMarket is its own vault, so totalAssets/totalNetAssets/
// ammAssets/pureCeilingAssets are one contract read each. Here they were
// hardwired to 0n — "graceful zero" — which cascaded: LP floor 0, share 0%,
// the Locker's LP totals 0.00, and the Vault page's accounting formulas all
// anchored on zeros dressed up as data. The truth is three reads away:
//
//   cash       vault_amm's token balance (USDC, 6dp)
//   liability  worst-case payout = max(qYes, qNo) at 1 USDC face
//   floor      cash − liability;  ceiling  cash − min(qYes, qNo)
//
// WAD share counts convert to 6dp by /1e12. Cached briefly because one page
// render asks for all four numbers for the same market.
const WAD_TO_USDC = 1_000_000_000_000n;

interface AmmFinance {
  cash: bigint; // 6dp
  floor: bigint; // 6dp
  ceiling: bigint; // 6dp
  creator: string; // base58
  lpSupplyRaw: bigint; // LP mint base units (6dp mint)
  lpMint: string; // base58
}

// The cache stores the PROMISE, not the value: one Locker render fires
// eight reads per market simultaneously, and a value-only cache let all
// eight miss together and each run the full four-RPC fetch — a thousand
// requests per refresh across thirty-two markets, which is what made the
// positions panel crawl while everything else was quick.
const financeCache = new Map<string, { at: number; v: Promise<AmmFinance | null> }>();

function readAmmFinance(
  ctx: PortfolioBridgeCtx,
  marketRef: string,
): Promise<AmmFinance | null> {
  const hit = financeCache.get(marketRef);
  if (hit && Date.now() - hit.at < 45_000) return hit.v;
  const p = readAmmFinanceUncached(ctx, marketRef).then((v) => {
    // A null (failed) read must not poison the cache for its full TTL.
    if (v === null) financeCache.delete(marketRef);
    return v;
  });
  financeCache.set(marketRef, { at: Date.now(), v: p });
  return p;
}

async function readAmmFinanceUncached(
  ctx: PortfolioBridgeCtx,
  marketRef: string,
): Promise<AmmFinance | null> {
  try {
    const adapter = ctx.adapter;
    const conn = adapter.connection;
    const marketPda = new PublicKey(marketRef.replace(/^sol:/, ""));
    const info = await conn.getAccountInfo(marketPda);
    if (!info) return null;
    // `Market.market_id` is [u8; 16], first field after the discriminator.
    const marketId = info.data.subarray(8, 8 + 16);
    const [vaultAmm] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_amm"), marketId],
      adapter.programIds.soothCore,
    );
    const [lpMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp"), marketId],
      adapter.programIds.soothCore,
    );
    let cash = 0n;
    try {
      cash = (await getAccount(conn, vaultAmm)).amount;
    } catch {
      // Vault not created yet — a market with no AMM has no cash.
    }
    let lpSupplyRaw = 0n;
    try {
      lpSupplyRaw = (await getMint(conn, lpMint)).supply;
    } catch {
      // Pre-seed_lp: no mint, no supply.
    }
    const amm = await adapter.readAmmState(marketRef);
    const qMax = (amm.qYes > amm.qNo ? amm.qYes : amm.qNo) / WAD_TO_USDC;
    const qMin = (amm.qYes > amm.qNo ? amm.qNo : amm.qYes) / WAD_TO_USDC;
    const v: AmmFinance = {
      cash,
      floor: cash > qMax ? cash - qMax : 0n,
      ceiling: cash > qMin ? cash - qMin : 0n,
      creator: String(amm.creator).replace(/^sol:/, ""),
      lpSupplyRaw,
      lpMint: lpMint.toBase58(),
    };
    return v;
  } catch {
    return null;
  }
}

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

    case "marketQuestion": {
      // The question, recovered from the market's creation transaction.
      //
      // Not an EVM method — there is no upstream equivalent, because on EVM
      // the question lives in contract storage. Here it exists only in the
      // `MarketCreated` event, so reading it means walking to the oldest
      // signature on the PDA and decoding the log. That is a real cost, which
      // is why callers cache the result and ask only when they have nothing.
      // `pickMarketRef` is the resolver the other market-PDA reads use: it
      // handles the address slot as well as args, which is how
      // `useOnChainMarkets` sends this one.
      const marketRef = pickMarketRef(call, ctx);
      if (!marketRef) return "";
      try {
        return (await ctx.adapter.readMarketQuestion(marketRef)) ?? "";
      } catch {
        // A market created before the event carried the question, or an
        // unreadable history. Empty string means "unknown", and the caller
        // falls back to the address — the state this whole path improves on,
        // not a regression.
        return "";
      }
    }

    case "isGraduated": {
      // Reads the real AmmState flag.
      //
      // This value gates `useOnChainMarkets`'s `stage = "live"`, which is what
      // routes a market to /orderbook/:addr. A hardcoded `false` here would
      // make the orderbook unreachable through the UI no matter what the
      // chain says.
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

    // ─── LP / Vault accounting — real chain state ───────────────────────
    case "totalAssets":
    case "ammAssets": {
      const marketRef = toMarketRef(call.address) ?? toMarketRef(call.args?.[0]);
      if (!marketRef) return 0n;
      return (await readAmmFinance(ctx, marketRef))?.cash ?? 0n;
    }

    case "totalNetAssets": {
      const marketRef = toMarketRef(call.address) ?? toMarketRef(call.args?.[0]);
      if (!marketRef) return 0n;
      return (await readAmmFinance(ctx, marketRef))?.floor ?? 0n;
    }

    case "pureCeilingAssets": {
      const marketRef = toMarketRef(call.address) ?? toMarketRef(call.args?.[0]);
      if (!marketRef) return 0n;
      return (await readAmmFinance(ctx, marketRef))?.ceiling ?? 0n;
    }

    case "graduationThreshold": {
      const marketRef = toMarketRef(call.address) ?? toMarketRef(call.args?.[0]);
      if (!marketRef) return 0n;
      try {
        const g = await ctx.adapter.readGraduationProgress(marketRef);
        return g.thresholdWad / 1_000_000_000_000n;
      } catch {
        return 0n;
      }
    }

    // The LP token is the market itself in the EVM ABI, so balanceOf on a
    // market PDA is the holder's LP ATA balance. Claimed here BEFORE the
    // amm-bridge's mint-shaped balanceOf, which would otherwise resolve the
    // market address to a venue mint and report the holder's USDC as "LP".
    case "balanceOf": {
      const marketRef = toMarketRef(call.address);
      if (!marketRef) return PORTFOLIO_NOT_HANDLED;
      const fin = await readAmmFinance(ctx, marketRef);
      if (!fin) return PORTFOLIO_NOT_HANDLED;
      const holder = String(call.args?.[0] ?? "").replace(/^(0x|sol:)/, "");
      try {
        const holderPk = new PublicKey(holder);
        const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
        const ata = getAssociatedTokenAddressSync(new PublicKey(fin.lpMint), holderPk, true);
        const amount = (await getAccount(ctx.adapter.connection, ata)).amount;
        return amount * 1_000_000_000_000n; // 6dp mint → the 18dp callers format
      } catch {
        // No ATA — a holder with no LP genuinely has zero.
        return 0n;
      }
    }

    // The LP token is the market itself in the EVM ABI, so totalSupply on a
    // market PDA is the real LP mint's supply. Scaled 6dp → 18dp because
    // every consumer formats with formatUnits(x, 18); the synthetic b·ln2
    // anchor in markets-bridge remains only for calls that name no market.
    case "totalSupply": {
      const marketRef = toMarketRef(call.address);
      if (!marketRef) return PORTFOLIO_NOT_HANDLED;
      const fin = await readAmmFinance(ctx, marketRef);
      if (!fin) return PORTFOLIO_NOT_HANDLED;
      return fin.lpSupplyRaw * 1_000_000_000_000n;
    }

    // ─── Locked-funds — graceful zero (no per-user EVM-shaped read here) ─
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

    case "creator": {
      // The real creator, in the shim's 0x<base58> convention. The zero
      // address here made every "Creator" row a $0 placeholder — the Vault
      // page's LP leaderboard listed "0x0000…0001" as the market's founder.
      const marketRef = toMarketRef(call.address) ?? toMarketRef(call.args?.[0]);
      if (!marketRef) return "0x0000000000000000000000000000000000000000";
      const fin = await readAmmFinance(ctx, marketRef);
      return fin ? `0x${fin.creator}` : "0x0000000000000000000000000000000000000000";
    }

    case "factory":
    case "outcomeToken":
    case "adjudicator":
      // Solana has no separate factory/adjudicator contract — return
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
