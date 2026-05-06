// chain-shim/amm-bridge.ts — routes the AMM page's wagmi-shim calls to
// real `SolanaChainAdapter` calls.
//
// Two integration points:
//
//   1. `dispatchAmmRead({ functionName, args }, ctx)` — pattern-matches the
//      `useReadContract` / `usePublicClient.readContract` argument shape
//      upstream's AMM hooks produce, and returns real adapter data formatted
//      to match the EVM tuple shape upstream expects.
//
//      Handled: getLiquidity, getMarketState, getPosition, getPositionQuote,
//      ERC20 balanceOf/allowance/decimals, AMMEngine.getBalances.
//
//      Unhandled function names fall through to the sentinel return so
//      orderbook / launchpad reads keep their existing empty-state behavior.
//
//   2. `dispatchAmmWrite({ functionName, args }, ctx)` — handles
//      `tradePositions` by calling `adapter.buildTrade` + `adapter.submit`.
//      Returns a synthetic Hash compatible with the wagmi return shape.
//      Other write function names (approve, redeemLP, etc.) are still
//      surfaced as `SolanaForkUnsupported` errors.
//
// The bridge re-shapes Solana adapter outputs into EVM-tuple shapes upstream
// `useDirectRead`-based hooks expect:
//
//   getMarketState  → readonly [qYes, qNo, yesPriceWad]
//   getLiquidity    → bigint (b, in WAD)
//   getPosition     → readonly [yesShares, noShares]
//   getPositionQuote→ readonly [cost, fee, netCost, newYesPrice]   // matches contract
//   getBalances     → readonly [available, locked]
//   balanceOf       → bigint (USDC token base units)
//   allowance       → bigint (large constant; Solana has no approvals)
//   decimals        → 6 (USDC)

import {
  PublicKey,
  type Connection as SolanaConnection,
} from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import {
  deriveUserUsdcAta,
  yesPriceWad,
  LN2_WAD,
  WAD,
  WAD_TO_USDC_SCALAR,
  type SolanaChainAdapter,
  type SignerRef,
} from "@sooth/sdk-solana";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AmmBridgeCtx {
  adapter: SolanaChainAdapter;
  connection: SolanaConnection;
  // The active wallet pubkey, base58. May be undefined in disconnected mode —
  // hooks gated on `userAddress` won't reach this branch.
  userBase58?: string;
  // The signer hooked up at the wallet-adapter layer (production) or
  // injected via DemoProvider override (tests).
  signer?: SignerRef | null;
}

// USDC mint decimals are fixed at 6 across all Sooth deployments. Centralize
// the constant so the EVM-shaped balance reads stay decoupled from
// adapter.usdcMint queries.
const USDC_DECIMALS = 6;

// ─── Read dispatcher ────────────────────────────────────────────────────────

/**
 * Returns the dispatched value if `functionName` matches an AMM-bridged
 * read; returns the sentinel `NOT_HANDLED` otherwise. Caller falls back
 * to its existing sentinel return on unhandled.
 */
export const NOT_HANDLED = Symbol("amm-bridge-not-handled");

export interface ReadCallShape {
  functionName?: string;
  args?: readonly unknown[];
  address?: unknown;
  // Upstream's `abi` slot is the empty array stub; we ignore it.
  abi?: unknown;
}

export async function dispatchAmmRead(
  call: ReadCallShape,
  ctx: AmmBridgeCtx,
): Promise<unknown | typeof NOT_HANDLED> {
  const fn = call.functionName;
  if (!fn) return NOT_HANDLED;

  switch (fn) {
    case "getLiquidity": {
      const marketRef = toMarketRef(call.args?.[0]);
      if (!marketRef) return 0n;
      try {
        const snap = await ctx.adapter.readSnapshot(marketRef);
        return snap.market.b;
      } catch {
        // AmmState not initialized → liquidity = 0 → upstream treats market
        // as uninitialized and shows the right empty-state.
        return 0n;
      }
    }

    case "getMarketState": {
      const marketRef = toMarketRef(call.args?.[0]);
      if (!marketRef) return [0n, 0n, 5n * 10n ** 17n] as const;
      try {
        const snap = await ctx.adapter.readSnapshot(marketRef);
        const { qYes, qNo, b } = snap.market;
        const price = yesPriceWad(qYes, qNo, b);
        return [qYes, qNo, price] as const;
      } catch {
        return [0n, 0n, 5n * 10n ** 17n] as const;
      }
    }

    case "getPosition": {
      const marketRef = toMarketRef(call.args?.[0]);
      const userRef = toAddressRef(call.args?.[1]);
      if (!marketRef || !userRef) return [0n, 0n] as const;
      try {
        const pos = await ctx.adapter.readPosition(marketRef, userRef);
        return [pos.yesShares, pos.noShares] as const;
      } catch {
        return [0n, 0n] as const;
      }
    }

    case "getPositionQuote": {
      const marketRef = toMarketRef(call.args?.[0]);
      const outcomeRaw = call.args?.[1];
      const deltaRaw = call.args?.[2];
      if (!marketRef) return [0n, 0n, 0n, 5n * 10n ** 17n] as const;
      const outcome = (Number(outcomeRaw) === 1 ? 1 : 0) as 0 | 1;
      const delta =
        typeof deltaRaw === "bigint"
          ? deltaRaw
          : BigInt((deltaRaw as any) ?? 0);
      try {
        // adapter.readQuote takes |delta| and an outcome — sign of delta
        // encodes buy/sell at the EVM contract layer; the adapter side has
        // separate helpers. We pass abs(delta) and assume buy here; sells
        // route through a different write path (still throws via adapter).
        const abs = delta < 0n ? -delta : delta;
        const q = await ctx.adapter.readQuote(marketRef, outcome, abs);
        return [q.cost, q.fee, q.netCost, q.newYesPrice] as const;
      } catch {
        return [0n, 0n, 0n, 5n * 10n ** 17n] as const;
      }
    }

    case "getBalances": {
      // AMMEngine.getBalances(user) → [available, locked]
      // No collateralizer / spendable-proceeds concept on Solana yet;
      // return zeros so upstream falls through to the wallet USDC path.
      return [0n, 0n] as const;
    }

    case "markets": {
      // LaunchpadEngine.markets(market) → [creator, lpToken, bBase,
      // creatorDeposit, graduatedAt]. Solana doesn't have a launchpad
      // engine — but the AMM page's `useLaunchpadMarketDirect` hook
      // uses creator !== ZERO_ADDRESS to gate "isMarketCreated", which
      // SimpleTradingPanel's `canTrade` requires. Return a synthetic
      // non-zero creator anchored to the live AMM's `b` parameter so
      // the gate flips on for any market with initialized AmmState.
      const marketRef = toMarketRef(call.args?.[0]);
      if (!marketRef) {
        return [
          "0x0000000000000000000000000000000000000000",
          "0x0000000000000000000000000000000000000000",
          0n,
          0n,
          0n,
        ] as const;
      }
      try {
        const snap = await ctx.adapter.readSnapshot(marketRef);
        // Synthetic creator ref — uses the user's address space so the
        // EVM-typed `0x${string}` slot type-checks. The value is opaque
        // to upstream code; only its non-zero-ness matters.
        const synthCreator = ("0x" + "1".padStart(40, "0")) as `0x${string}`;
        // Synthetic `creatorDeposit` ≈ b · ln(2), expressed in USDC base
        // units (6 decimals), matching the convention upstream expects
        // (LaunchpadEngine.markets()'s `creatorDeposit` slot is in USDC
        // base units, not WAD). MarketStats's `seed` term reads this and
        // feeds the legacy `gross` calculation; without a non-zero value
        // the projection rows render as $0.
        const seedWad = (snap.market.b * LN2_WAD) / WAD;
        const creatorDeposit = seedWad / WAD_TO_USDC_SCALAR;
        return [
          synthCreator,
          synthCreator,
          snap.market.b,
          creatorDeposit,
          0n,
        ] as const;
      } catch {
        return [
          "0x0000000000000000000000000000000000000000",
          "0x0000000000000000000000000000000000000000",
          0n,
          0n,
          0n,
        ] as const;
      }
    }

    case "trialEndTimes": {
      // LaunchpadEngine.trialEndTimes(market) → uint256.
      // Solana programs lock trial period inside AmmState; the exact
      // surface isn't on `MarketInfo` yet. Return 0 so upstream treats
      // the market as past-trial (no trial gating).
      return 0n;
    }

    case "preGradFeeBps":
    case "postGradFeeBps": {
      // FeeRouter fee bps. The on-chain fee router is stubbed
      // (`trade_positions.rs §3`), so quotes round-trip with fee=0.
      // Return EVM defaults so upstream's UI shows the canonical
      // pre/post-graduation rates.
      return call.functionName === "preGradFeeBps" ? 500n : 100n;
    }

    case "lpYieldShareBps": {
      return 3000n;
    }

    case "getGraduationProgress": {
      // (feesAccrued, graduationThreshold, progressBps).
      return [0n, 0n, 0n] as const;
    }

    case "totalSupply": {
      return 0n;
    }

    case "balanceOf": {
      // Two callers: (1) ERC20 USDC balance (user's wallet), (2) generic
      // ERC20 balanceOf the AMMEngine on USDC (used by useAmmMarketDirect
      // to surface "lockedProceeds"). Only attempt the SPL token read
      // when the address parses as base58 — EVM contract addresses
      // (like the AMMEngine) come through as `0x1Bab...` and we return
      // 0n for those without surfacing a noisy decode error.
      const userAddr = toAddressRef(call.args?.[0]);
      if (!userAddr) return 0n;
      const tail = userAddr.replace(/^sol:/, "");
      let userPk: PublicKey;
      try {
        userPk = new PublicKey(tail);
      } catch {
        return 0n;
      }
      try {
        const ata = deriveUserUsdcAta(userPk, ctx.adapter.usdcMint);
        const acc = await getAccount(ctx.connection, ata);
        return acc.amount;
      } catch {
        return 0n;
      }
    }

    case "allowance": {
      // Solana has no allowance concept. Return a saturated value so
      // upstream's `needsApproval` short-circuits to false.
      return (1n << 128n) - 1n;
    }

    case "decimals": {
      return USDC_DECIMALS;
    }

    default:
      return NOT_HANDLED;
  }
}

// ─── Write dispatcher ───────────────────────────────────────────────────────

export interface WriteCallShape {
  functionName?: string;
  args?: readonly unknown[];
  address?: unknown;
  abi?: unknown;
}

/**
 * Handles `tradePositions(market, outcome, deltaShares, slippageLimit)` and
 * `claimUnlocked(maxClaims)`. Returns a synthetic transaction signature
 * (Solana sig encoded as a `0x`-prefixed hex-ish string so it round-trips
 * through EVM-typed Hash slots). Returns NOT_HANDLED for unrecognized
 * writes — caller surfaces `SolanaForkUnsupported`.
 *
 * Buy/sell dispatch: the EVM contract collapses both into one
 * `tradePositions` call where the sign of `deltaShares` selects the path
 * (positive → buy, negative → sell). On Solana the buy path lives on
 * `trade_positions` and the sell path on `sell_positions` (Wave 1A); the
 * bridge picks the SDK builder by sign here.
 */
export async function dispatchAmmWrite(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string | typeof NOT_HANDLED> {
  if (call.functionName === "tradePositions") {
    return dispatchTrade(call, ctx);
  }
  if (call.functionName === "claimUnlocked") {
    return dispatchClaim(call, ctx);
  }
  return NOT_HANDLED;
}

async function dispatchTrade(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  if (!ctx.signer) {
    throw new Error(
      "tradePositions: no Solana signer available — connect a wallet first",
    );
  }
  if (!ctx.userBase58) {
    throw new Error(
      "tradePositions: no Solana wallet pubkey — connect a wallet first",
    );
  }
  const args = call.args ?? [];
  const marketRef = toMarketRef(args[0]);
  if (!marketRef) {
    throw new Error("tradePositions: invalid market address");
  }
  const outcome = (Number(args[1]) === 1 ? 1 : 0) as 0 | 1;
  const deltaShares =
    typeof args[2] === "bigint" ? args[2] : BigInt((args[2] as any) ?? 0);
  const limitCost =
    typeof args[3] === "bigint" ? args[3] : BigInt((args[3] as any) ?? 0);

  const userRef = `sol:${ctx.userBase58}`;
  const isSell = deltaShares < 0n;
  const absDelta = isSell ? -deltaShares : deltaShares;

  if (isSell) {
    // SELL: route to `buildSell` → `sell_positions` ix. EVM's slippage
    // anchor is `quote.cost * 95%` (a *minimum* proceeds value); pass it
    // through as `minProceedsWad`. The adapter applies the wire-side sign
    // flip — pass the absolute share count.
    const req = await ctx.adapter.buildSell(marketRef, {
      outcome,
      deltaShares: absDelta,
      minProceedsWad: limitCost > 0n ? limitCost : 0n,
      user: userRef,
    });
    const receipt = await ctx.adapter.submit(req, ctx.signer);
    const sig = receipt.txId.replace(/^sol:/, "");
    return synthHashFromSignature(sig);
  }

  // BUY: existing path through `buildTrade` → `trade_positions` ix.
  const req = await ctx.adapter.buildTrade(marketRef, {
    side: "buy",
    outcome,
    deltaShares: absDelta,
    maxCostWad: limitCost,
    // @ts-expect-error — Solana-only meta channel; see adapter.ts.
    user: userRef,
  });

  const receipt = await ctx.adapter.submit(req, ctx.signer);
  // `txId` is `sol:<base58 signature>`. Encode into a synthetic hex hash
  // so wagmi-shaped Hash slots accept it. The signature is opaque to
  // upstream's UI — only the toast text reads it.
  const sig = receipt.txId.replace(/^sol:/, "");
  return synthHashFromSignature(sig);
}

async function dispatchClaim(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  // Upstream's `useClaimUnlocked` calls `writeContract({ address: ammEngine,
  // functionName: "claimUnlocked", args: [maxClaims] })`. EVM walks the
  // user's storage queue server-side; on Solana each LockEntry is its own
  // PDA so we drain one per ix invocation. The bridge resolves the *first*
  // matured LockEntry on the active market and submits a single claim. If
  // none exists, throw a non-fatal error the upstream form can surface.
  if (!ctx.signer) {
    throw new Error(
      "claimUnlocked: no Solana signer available — connect a wallet first",
    );
  }
  if (!ctx.userBase58) {
    throw new Error(
      "claimUnlocked: no Solana wallet pubkey — connect a wallet first",
    );
  }

  // The EVM `claimUnlocked(maxClaims)` ABI passes the user's queue limit;
  // the Solana shim doesn't need it (we drain one per call). Allow a
  // shim-side hook to override the active market via a conventional
  // shim-only first arg (`{ market, lockEntry }` object). If neither is
  // provided, fail loudly — the bridge can't infer market context.
  const args = call.args ?? [];
  const explicit =
    typeof args[0] === "object" && args[0] !== null
      ? (args[0] as { market?: unknown; lockEntry?: unknown })
      : null;

  let marketRef: string | undefined;
  let lockEntryRef: string | undefined;
  if (explicit) {
    marketRef = toMarketRef(explicit.market);
    lockEntryRef =
      typeof explicit.lockEntry === "string"
        ? explicit.lockEntry.startsWith("sol:")
          ? explicit.lockEntry
          : `sol:${explicit.lockEntry}`
        : undefined;
  }

  if (!marketRef) {
    throw new Error(
      "claimUnlocked: market reference unavailable — pass via args[0].market",
    );
  }
  if (!lockEntryRef) {
    throw new Error(
      "claimUnlocked: lock entry reference unavailable — pass via args[0].lockEntry",
    );
  }

  const req = await ctx.adapter.buildClaim(marketRef, {
    outcome: 0, // ClaimArgs.outcome is unused on the Solana path; placeholder.
    user: `sol:${ctx.userBase58}`,
    lockEntry: lockEntryRef,
  } as never);

  const receipt = await ctx.adapter.submit(req, ctx.signer);
  const sig = receipt.txId.replace(/^sol:/, "");
  return synthHashFromSignature(sig);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Coerce one of the address-shaped values upstream code passes through the
 * shim into a Solana-compatible `MarketRef` (`sol:<base58>`).
 *
 * Accepts: `sol:<base58>`, raw `<base58>`, or `0x<base58>` (the synthetic
 * shape the wagmi-shim's `useAccount` produces).
 */
function toMarketRef(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  if (v.startsWith("sol:")) return v;
  // 0x prefix — `useAccount` wrapping. Drop the prefix.
  if (v.startsWith("0x")) {
    const tail = v.slice(2);
    if (!tail) return undefined;
    return `sol:${tail}`;
  }
  return `sol:${v}`;
}

function toAddressRef(v: unknown): string | undefined {
  return toMarketRef(v);
}

/**
 * Pad a Solana base58 signature into a 32-byte hex string so it satisfies
 * upstream's `0x${string}` Hash typing. Truncate / pad — the value is only
 * used in toast messages.
 */
function synthHashFromSignature(sig: string): string {
  // Lowercase a-f, pad with zeros. Output is `0x` + 64 hex chars.
  const hex = Buffer.from(sig).toString("hex").slice(0, 64);
  return ("0x" + hex.padEnd(64, "0")) as string;
}
