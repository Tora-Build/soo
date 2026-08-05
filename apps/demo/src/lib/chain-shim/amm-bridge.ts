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
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  type Connection as SolanaConnection,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  deriveUserUsdcAta,
  yesPriceWad,
  LN2_WAD,
  WAD,
  WAD_TO_USDC_SCALAR,
  DEFAULT_MATCH_LIMIT_PER_TX,
  submitOrderbookBuyMultiTx,
  soothCoreIdl,
  type SolanaChainAdapter,
  type SignerRef,
  type SoothRequest,
} from "@sooth/sdk-solana";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { myAccount, selfCrossExposure } from "../book-view";

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
  // Active market ref (`sol:<soothMarketPda>`) — orderbook dispatchers need
  // it to resolve the real market PDA, since upstream's orderbook hook
  // hashes `marketAddress` into a `marketKey` (FNV-1a in our shim) that's
  // useless on Solana. Sourced from `DemoContext.marketRef`. May be null on
  // pages where no single market is active.
  marketRef?: string | null;
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

    case "getSelfCrossExposure": {
      // "Would this order cross only my own resting orders?"
      //
      // The matcher cancels such a remainder rather than resting it, so the
      // transaction succeeds and the order simply never appears. Asking first
      // lets the form say so instead of leaving the trader to wonder where it
      // went.
      const marketRef = toMarketRef(call.args?.[0]);
      const owner = toAddressRef(call.args?.[1]);
      const side = Number(call.args?.[2]);
      const limitTick = Number(call.args?.[3]);
      const amount = BigInt((call.args?.[4] as string | bigint) ?? 0n);
      if (!marketRef || !owner) return [false, 0n, 0n] as const;
      const snapshot = await readBookCached(ctx, marketRef);
      if (!snapshot) return [false, 0n, 0n] as const;
      const r = selfCrossExposure(
        snapshot,
        owner.replace(/^sol:/, ""),
        side,
        limitTick,
        amount,
      );
      return [r.crosses, r.ownAmount, r.othersAmount] as const;
    }

    case "getBookAccount": {
      // A trader's standing inside the book: withdrawable credit, collateral
      // locked behind resting orders, and net share position.
      //
      // The Trading Account card hardcoded `reserved = 0`, so escrowed
      // collateral was invisible — a trader who placed orders saw their wallet
      // balance drop with nothing on the page to account for it.
      const marketRef = toMarketRef(call.args?.[0]);
      const owner = toAddressRef(call.args?.[1]);
      if (!marketRef || !owner) return [0n, 0n, 0n, 0n] as const;
      const snapshot = await readBookCached(ctx, marketRef);
      if (!snapshot) return [0n, 0n, 0n, 0n] as const;
      const acct = myAccount(snapshot, owner.replace(/^sol:/, ""));
      return [acct.credit, acct.escrow, acct.net, BigInt(acct.openOrders)] as const;
    }

    case "getMyOpenOrders": {
      // The redesigned book's answer to "what are my resting orders".
      //
      // The legacy path reconstructs this by replaying OrderPlaced /
      // OrderCancelled / OrdersFilled logs and netting them per price level —
      // event sourcing, over a chunked getLogs scan, producing an order id
      // synthesised as `${side}:${tick}` because a level is all it can know.
      //
      // Here the orders ARE the account. One read, exact amounts, and every
      // order carries its real `seq` — which is what `book_cancel` takes, and
      // what removes the synthesised-id round trip entirely.
      const marketRef = toMarketRef(call.args?.[0]);
      const owner = toAddressRef(call.args?.[1]);
      if (!marketRef || !owner) return [] as readonly unknown[];
      const snapshot = await readBookCached(ctx, marketRef);
      if (!snapshot) return [] as readonly unknown[];
      const ownerBase58 = owner.replace(/^sol:/, "");
      const mine: unknown[] = [];
      for (const [side, orders] of [
        [0, snapshot.bids],
        [1, snapshot.asks],
      ] as const) {
        for (const o of orders) {
          if (o.trader !== ownerBase58) continue;
          mine.push({
            seq: o.seq,
            side,
            priceTick: o.priceTick,
            amount: o.amount,
          });
        }
      }
      // Earliest first — the order the matcher would consume them.
      mine.sort((a, b) => {
        const x = (a as { seq: bigint }).seq;
        const y = (b as { seq: bigint }).seq;
        return x < y ? -1 : x > y ? 1 : 0;
      });
      return mine as readonly unknown[];
    }

    case "getMyOrderHistory": {
      // Order history from the book's own CPI events.
      //
      // The legacy path replays EVM-shaped ORDER_PLACED / ORDER_CANCELLED /
      // ORDER_FILLED logs through `getLogs`. The redesigned book emits none of
      // those signatures, and there is no indexer on this fork
      // (VITE_USE_INDEXER=false), so history was always empty.
      const marketRef = toMarketRef(call.args?.[0]);
      const owner = toAddressRef(call.args?.[1]);
      if (!marketRef || !owner) return [] as readonly unknown[];
      const ownerBase58 = owner.replace(/^sol:/, "");

      let records: Awaited<ReturnType<typeof ctx.adapter.readBookHistory>>;
      try {
        records = await ctx.adapter.readBookHistory(marketRef, { limit: 200 });
      } catch {
        // No book, or an RPC that does not serve signature history. Degrade to
        // empty rather than stalling the panel on a thrown promise.
        return [] as readonly unknown[];
      }

      // A `cancelled` event carries only the seq — not the side or the price,
      // since the program already freed the node by the time it emits. The
      // matching `placed` event is in this same stream, so remember each
      // order's terms as it goes by and enrich the later rows from it.
      // Without this a cancel renders as an order with no price.
      const terms = new Map<string, { side: number; priceTick: number }>();

      const rows: unknown[] = [];
      for (const { signature, event } of records) {
        if (event.kind === "placed") {
          terms.set(event.seq.toString(), {
            side: event.side,
            priceTick: event.priceTick,
          });
          if (event.trader !== ownerBase58) continue;
          rows.push({
            signature,
            type: "placed",
            seq: event.seq,
            side: event.side,
            priceTick: event.priceTick,
            amount: event.amount,
            refund: 0n,
            ts: event.ts,
          });
          continue;
        }

        if (event.kind === "cancelled") {
          if (event.trader !== ownerBase58) continue;
          const t = terms.get(event.seq.toString());
          rows.push({
            signature,
            type: "cancelled",
            seq: event.seq,
            // null when the order was placed outside the fetched window —
            // honest about the gap rather than rendering a made-up price.
            side: t?.side ?? null,
            priceTick: t?.priceTick ?? null,
            amount: 0n,
            refund: event.refund,
            ts: event.ts,
          });
          continue;
        }

        // A fill touches two parties, and the panel must show it to both: the
        // taker who crossed, and every maker whose resting order was consumed.
        // Attributing it to the taker alone would hide from a maker that their
        // order traded at all.
        if (event.taker === ownerBase58) {
          for (const f of event.fills) {
            rows.push({
              signature,
              type: "filled",
              role: "taker",
              seq: f.makerSeq,
              side: event.takerSide,
              // Execution price is the MAKER's tick, not the taker's limit —
              // that difference IS the price improvement the taker received.
              priceTick: f.priceTick,
              amount: f.amount,
              fee: event.fee,
              ts: event.ts,
            });
          }
        }
        for (const f of event.fills) {
          if (f.maker !== ownerBase58) continue;
          rows.push({
            signature,
            type: "filled",
            role: "maker",
            seq: f.makerSeq,
            // The maker sat on the side opposite the taker.
            side: event.takerSide === 0 ? 1 : 0,
            priceTick: f.priceTick,
            amount: f.amount,
            fee: 0n, // the taker pays the fee
            ts: event.ts,
          });
        }
      }
      return rows as readonly unknown[];
    }

    case "getOrdersAtTick": {
      // EVM SoothBook.getOrdersAtTick(marketKey, side, tick) →
      // (totalAmount: u128, makers: Order[]).
      //
      // This used to return `[0n, []]` unconditionally — the depth panel
      // always read "no liquidity" — because the legacy book stores one
      // account per price level and there was no way to enumerate them
      // without 999 RPC round trips.
      //
      // The redesigned book is a SINGLE account, so the whole ladder comes
      // from one `getAccountInfo`. `useOrderbook` still issues 999 of these
      // through its multicall loop, but every one after the first is now
      // served from a short-lived cache of that one fetch, not the network.
      //
      // The non-empty tuple shape stays load-bearing:
      // `useOrderbook.scanTickDepth` destructures `[totalAmount] =
      // result.result`, and a bare `undefined` throws inside the multicall
      // loop, leaving `isLoading` stuck on the first poll.
      const marketRef = toMarketRef(call.args?.[0]);
      const side = Number(call.args?.[1] ?? -1);
      const tick = Number(call.args?.[2] ?? 0);
      if (!marketRef || (side !== 0 && side !== 1)) {
        return [0n, [] as readonly unknown[]] as const;
      }
      const snapshot = await readBookCached(ctx, marketRef);
      if (!snapshot) return [0n, [] as readonly unknown[]] as const;

      // On the unified axis both sides quote the YES price, so a tick maps
      // straight through — no complement flip, which is what the legacy
      // two-sided book required and what made it easy to render the wrong
      // side of the market.
      const orders = (side === 1 ? snapshot.bids : snapshot.asks).filter(
        (o) => o.priceTick === tick,
      );
      const total = orders.reduce((acc, o) => acc + o.amount, 0n);
      return [total, orders as readonly unknown[]] as const;
    }

    case "isMarketRegistered": {
      // SoothBookTerminal gates the trade form on this read. MarketBook is
      // lazy-created by the first buy_yes/buy_no, so a valid sooth_market PDA
      // is enough to consider the book available.
      const raw = call.args?.[0];
      if (typeof raw !== "string" || !raw) return false;
      const tail = raw.startsWith("0x")
        ? raw.slice(2)
        : raw.startsWith("sol:")
          ? raw.slice(4)
          : raw;
      let candidate: PublicKey;
      try {
        candidate = new PublicKey(tail);
      } catch {
        return false;
      }
      try {
        // Path 1: candidate is already the lazy-created MarketBook PDA.
        const direct = await ctx.connection.getAccountInfo(candidate);
        if (direct) return true;
        // Path 2: candidate is the soothMarketPda.
        await ctx.adapter.resolveOrderbookMarket(`sol:${candidate.toBase58()}`);
        return true;
      } catch {
        return false;
      }
    }

    case "getBalance": {
      // SoothBook.getBalance(marketKey, user) → (yesShares, noShares) in WAD.
      // `marketKey` is the FNV hash of `marketAddress` produced by viem-shim
      // (see useOrderbookTrade.ts:259) — not invertible to a Solana PDA.
      // Resolve the market via `ctx.marketRef` (the active market on the
      // demo page), fetch the on-chain Market account to learn yes/no mint
      // pubkeys, then read the user's outcome ATA balances.
      //
      // Returns 0n on each side for users with no ATA (never traded) — that
      // matches the empty-state semantics upstream's hooks expect.
      if (!ctx.marketRef) return [0n, 0n] as const;
      const userRef = toAddressRef(call.args?.[1]);
      if (!userRef) return [0n, 0n] as const;
      const userTail = userRef.replace(/^sol:/, "");
      let userPk: PublicKey;
      try {
        userPk = new PublicKey(userTail);
      } catch {
        return [0n, 0n] as const;
      }
      let soothMarketPda: PublicKey;
      try {
        soothMarketPda = decodeSolMarketRef(ctx.marketRef);
      } catch {
        return [0n, 0n] as const;
      }
      try {
        // Fetch the Market account to recover yesMint / noMint. The adapter
        // doesn't expose a public read for this, so we re-derive the
        // soothMarket Anchor program inline (same minimal AnchorProvider
        // shape dispatchAddAdjudicator uses).
        const stubWallet = {
          publicKey: userPk,
          signTransaction: async <T>(tx: T): Promise<T> => tx,
          signAllTransactions: async <T>(txs: T[]): Promise<T[]> => txs,
        };
        const provider = new AnchorProvider(
          ctx.connection,
          stubWallet as never,
          { commitment: "confirmed", preflightCommitment: "confirmed" },
        );
        const programIdl = {
          ...soothCoreIdl,
          address: ctx.adapter.programIds.soothCore.toBase58(),
        };
        const program = new Program(programIdl as Idl, provider);
        const market = (await (program.account as any).market.fetchNullable(
          soothMarketPda,
        )) as { yesMint?: PublicKey; noMint?: PublicKey } | null;
        if (!market?.yesMint || !market?.noMint) return [0n, 0n] as const;
        const yesAta = getAssociatedTokenAddressSync(market.yesMint, userPk);
        const noAta = getAssociatedTokenAddressSync(market.noMint, userPk);
        const [yesShares, noShares] = await Promise.all([
          getAccount(ctx.connection, yesAta)
            .then((a) => a.amount)
            .catch(() => 0n),
          getAccount(ctx.connection, noAta)
            .then((a) => a.amount)
            .catch(() => 0n),
        ]);
        return [yesShares, noShares] as const;
      } catch {
        return [0n, 0n] as const;
      }
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
  if (call.functionName === "mint") {
    return dispatchMint(call, ctx);
  }
  if (call.functionName === "createMarket") {
    return dispatchCreateMarket(call, ctx);
  }
  if (call.functionName === "addAdjudicator") {
    return dispatchAddAdjudicator(call, ctx);
  }
  if (call.functionName === "mintCompleteSet") {
    return dispatchCompleteSet(call, ctx, "mint");
  }
  if (call.functionName === "mergeCompleteSet") {
    return dispatchCompleteSet(call, ctx, "merge");
  }
  if (call.functionName === "redeem") {
    return dispatchRedeem(call, ctx);
  }
  if (call.functionName === "requestLock") {
    return dispatchRequestLock(call, ctx);
  }
  if (call.functionName === "attestOutcome") {
    return dispatchAttestOutcome(call, ctx);
  }
  if (call.functionName === "settle") {
    return dispatchSettle(call, ctx);
  }
  if (call.functionName === "dismissMarket") {
    return dispatchDismissMarket(call, ctx);
  }
  if (call.functionName === "claimRefund") {
    return dispatchClaimRefund(call, ctx);
  }
  if (call.functionName === "redeemLp") {
    return dispatchRedeemLp(call, ctx);
  }
  if (
    call.functionName === "buyYes" ||
    call.functionName === "buyNo" ||
    call.functionName === "cancel" ||
    call.functionName === "cancelById"
  ) {
    return dispatchOrderbookWrite(call, ctx);
  }
  // Redesigned book. Distinct function names rather than a mode flag on the
  // legacy ones, so a caller cannot land on the wrong book by accident while
  // both are live.
  if (call.functionName === "bookPlace") {
    return dispatchBookPlace(call, ctx);
  }
  if (call.functionName === "bookCancel") {
    return dispatchBookCancel(call, ctx);
  }
  if (call.functionName === "bookWithdraw") {
    return dispatchBookWithdraw(call, ctx);
  }
  return NOT_HANDLED;
}

async function dispatchTrade(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "tradePositions");
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

  const userRef = `sol:${userBase58}`;
  const isSell = deltaShares < 0n;
  const absDelta = isSell ? -deltaShares : deltaShares;

  // SELL: route to `buildSell` → `sell_positions` ix. EVM's slippage
  // anchor is `quote.cost * 95%` (a *minimum* proceeds value); pass it
  // through as `minProceedsWad`. The adapter applies the wire-side sign
  // flip — pass the absolute share count.
  // BUY: existing path through `buildTrade` → `trade_positions` ix.
  const req = isSell
    ? await ctx.adapter.buildSell(marketRef, {
        outcome,
        deltaShares: absDelta,
        minProceedsWad: limitCost > 0n ? limitCost : 0n,
        user: userRef,
      })
    : await ctx.adapter.buildTrade(marketRef, {
        side: "buy",
        outcome,
        deltaShares: absDelta,
        maxCostWad: limitCost,
        // @ts-expect-error — Solana-only meta channel; see adapter.ts.
        user: userRef,
      });
  return submitAndSynth(ctx.adapter, req, signer);
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
  const { signer, userBase58 } = requireWallet(ctx, "claimUnlocked");

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
    user: `sol:${userBase58}`,
    lockEntry: lockEntryRef,
  });
  return submitAndSynth(ctx.adapter, req, signer);
}

/**
 * Faucet path. Upstream's `Faucet.tsx` calls
 *   `writeContractAsync({ functionName: "mint", args: [address, amount] })`
 * against the EVM `MockUSDC` contract. On Solana the equivalent is an SPL
 * `MintTo` ix signed by the localnet mint authority. The authority's
 * secret key is inlined via `VITE_TEST_MINT_AUTHORITY_BYTES` (see
 * `apps/demo/scripts/seed-localnet.mjs`).
 *
 * The recipient is ALWAYS `ctx.userBase58` — `args[0]` is an EVM-shaped
 * address slot and is intentionally ignored. This prevents the in-browser
 * faucet from minting to arbitrary wallets even if the upstream UI passes
 * a different `to` field.
 */
async function dispatchMint(
  _call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  if (!ctx.userBase58) {
    throw new Error("mint: no Solana wallet pubkey — connect a wallet first");
  }
  const args = _call.args ?? [];
  const amount =
    typeof args[1] === "bigint" ? args[1] : BigInt((args[1] as any) ?? 0);
  if (amount <= 0n) {
    throw new Error("mint: amount must be positive");
  }

  const rawBytes = (
    import.meta as unknown as { env: Record<string, string | undefined> }
  ).env?.VITE_TEST_MINT_AUTHORITY_BYTES;
  if (!rawBytes) {
    throw new Error(
      "VITE_TEST_MINT_AUTHORITY_BYTES required for faucet mint on localnet (regenerate .env.local via pnpm dev:localnet)",
    );
  }

  let mintAuthority: Keypair;
  try {
    const arr = JSON.parse(rawBytes) as number[];
    mintAuthority = Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch (e) {
    throw new Error(
      `VITE_TEST_MINT_AUTHORITY_BYTES is not a valid JSON byte array: ${(e as Error).message}`,
    );
  }

  const recipient = new PublicKey(ctx.userBase58);
  const usdcMint = ctx.adapter.usdcMint;
  const recipientAta = getAssociatedTokenAddressSync(usdcMint, recipient);

  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      mintAuthority.publicKey,
      recipientAta,
      recipient,
      usdcMint,
    ),
  );
  tx.add(
    createMintToInstruction(
      usdcMint,
      recipientAta,
      mintAuthority.publicKey,
      amount,
    ),
  );

  const { blockhash, lastValidBlockHeight } =
    await ctx.adapter.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = mintAuthority.publicKey;
  tx.partialSign(mintAuthority);

  const serialized = tx.serialize();
  const sig = await ctx.adapter.connection.sendRawTransaction(serialized, {
    skipPreflight: false,
  });
  await ctx.adapter.connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return synthHashFromSignature(sig);
}

/**
 * Launchpad path. Upstream's `Launchpad.tsx` calls
 *   `writeContractAsync({ functionName: "createMarket", args: [
 *     sqfQuestion, startTime, deadline, customAdjudicator,
 *     bWei, initialProbabilityWad, adjudicatorConfig
 *   ]})`
 * against `LaunchpadEngine`. We map the relevant args onto
 * `adapter.buildCreateMarket` and submit. The new market's PDA is stashed
 * on a global side channel (`globalThis.__lastCreatedMarketPda`) because
 * the EVM-flavored receipt-decoding path upstream loops over event logs to
 * extract `marketAddress` — Solana has no equivalent ABI dispatch, so the
 * shim hands the PDA off out-of-band.
 */
async function dispatchCreateMarket(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "createMarket");
  const args = call.args ?? [];

  const question =
    typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
  const deadlineRaw = args[2];
  const deadline =
    typeof deadlineRaw === "bigint"
      ? deadlineRaw
      : BigInt((deadlineRaw as any) ?? 0);
  if (deadline <= 0n) {
    throw new Error("createMarket: deadline must be positive");
  }
  const initialBRaw = args[4];
  const initialB =
    typeof initialBRaw === "bigint"
      ? initialBRaw
      : BigInt((initialBRaw as any) ?? 0);

  // EVM `customAdjudicator` is a 0x-prefixed address. We can't decode that
  // into a Solana pubkey, so the bridge defaults to the connected user as
  // both creator and adjudicator (matches the localnet seed default — the
  // creator wallet is the on-chain allowlist authority + per-market
  // adjudicator). Future work: surface a Solana-typed adjudicator picker.
  const userRef = `sol:${userBase58}`;

  const req = await ctx.adapter.buildCreateMarket({
    question,
    deadline,
    initialB: initialB > 0n ? initialB : undefined,
    user: userRef,
    adjudicator: userRef,
  });

  // Stash the market PDA on a global side channel BEFORE submit so the
  // caller (Launchpad.tsx) can pick it up after `writeContractAsync`
  // resolves. We can't surface it through the synthetic Hash return type
  // without breaking upstream's typing.
  const meta = req.meta as { marketPda?: string } | undefined;
  if (meta?.marketPda) {
    (
      globalThis as unknown as { __lastCreatedMarketPda?: string }
    ).__lastCreatedMarketPda = meta.marketPda;
    const g = globalThis as unknown as { __soothCreatedMarketPdas?: string[] };
    const merged = [
      ...new Set([...(g.__soothCreatedMarketPdas ?? []), meta.marketPda]),
    ];
    g.__soothCreatedMarketPdas = merged;
    // Mirror to sessionStorage so the side channel survives page.goto
    // navigations (window-scoped globals get wiped between routes in
    // Playwright). markets-bridge / portfolio-bridge read both.
    try {
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.setItem(
          "__soothCreatedMarketPdas",
          JSON.stringify(merged),
        );
      }
    } catch {
      // sessionStorage may be disabled in some contexts; the in-memory
      // global still works for single-page flows.
    }
  }

  return submitAndSynth(ctx.adapter, req, signer);
}

/**
 * Auto-register the connected wallet as an adjudicator. Localnet-only:
 * `sooth_market::add_adjudicator(adjudicator)` is signed by the on-chain
 * allowlist authority, which on localnet is the creator keypair shipped via
 * `VITE_TEST_AUTHORITY_BYTES` (see `apps/demo/scripts/seed-localnet.mjs`).
 *
 * The dapp calls this exactly once per fresh wallet pubkey on connect,
 * before any UI flow that needs the wallet to be allow-listed (createMarket,
 * operator settle/attest). If the wallet is already registered the on-chain
 * `AdjudicatorAlreadyAllowlisted` error is treated as success — the
 * pre-condition is satisfied either way.
 *
 * Args:
 *   args[0]: optional Solana base58 pubkey to register. When omitted,
 *            registers `ctx.userBase58` (the connected wallet).
 */
async function dispatchAddAdjudicator(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  if (!ctx.userBase58) {
    throw new Error(
      "addAdjudicator: no Solana wallet pubkey — connect a wallet first",
    );
  }
  const args = call.args ?? [];
  const explicit = typeof args[0] === "string" ? args[0] : undefined;
  const adjudicatorPk = new PublicKey(explicit ?? ctx.userBase58);

  // The allowlist this used to write no longer exists.
  //
  // Upstream EVM has `AdjudicatorRegistry.addAdjudicator`, and the pre-merge
  // Solana port mirrored it with a global 16-slot `AdjudicatorAllowlist` PDA
  // (seed "adjudicator_allowlist") plus authority-gated add/remove
  // instructions. The 5→1 merge deleted all of that: sooth_core registers
  // adjudicators PER MARKET via `register_adjudicator`, gated by the single
  // `ProtocolConfig.permissionless_adjudicators` flag.
  //
  // So the precondition this call existed to establish — "this adjudicator is
  // permitted" — is already true whenever `permissionless_adjudicators` is
  // set, which it is on our devnet and localnet configs. Registration itself
  // happens at market creation, not here.
  //
  // Reporting success is therefore honest rather than a stub: there is nothing
  // to do. Pointing it at sooth_core would compile and then fail at runtime
  // with InstructionFallbackNotFound, since no `add_adjudicator` instruction
  // exists to dispatch to.
  //
  // If permissionless registration is ever turned off, this needs to become a
  // real `register_adjudicator` call taking a market — which means it needs a
  // market argument it does not currently receive.
  void adjudicatorPk;
  return synthHashFromSignature("1".repeat(64));
}

/**
 * Mint or merge an orderbook complete set.
 *
 *   mint:  N USDC in → N·WAD YES + N·WAD NO on OrderbookPosition
 *   merge: N·WAD YES + N·WAD NO from OrderbookPosition → N USDC out
 *
 * Routes through `adapter.buildOrderbookMint` /
 * `adapter.buildOrderbookMerge` for ix construction and `adapter.submit`
 * for sign/send/confirm — same machinery the trade path uses.
 *
 * Args:
 *   args[0]: market reference — `0x<base58>` or `sol:<base58>`
 *   args[1]: amount in USDC base units (u64). For merge this is also the
 *            count of YES + NO shares burned (1 USDC = 1·WAD YES = 1·WAD NO).
 */
async function dispatchCompleteSet(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
  kind: "mint" | "merge",
): Promise<string> {
  const op = `${kind}CompleteSet`;
  const { signer, userBase58 } = requireWallet(ctx, op);
  const args = call.args ?? [];
  const marketRef = toMarketRef(args[0]);
  if (!marketRef) {
    throw new Error(`${op}: invalid market reference`);
  }
  const amount =
    typeof args[1] === "bigint" ? args[1] : BigInt((args[1] as any) ?? 0);
  if (amount <= 0n) {
    throw new Error(`${op}: amount must be positive`);
  }

  const userArgs = { user: `sol:${userBase58}`, amount };
  const req =
    kind === "mint"
      ? await ctx.adapter.buildOrderbookMint(marketRef, userArgs)
      : await ctx.adapter.buildOrderbookMerge(marketRef, userArgs);
  return submitAndSynth(ctx.adapter, req, signer);
}

/**
 * Post-settlement redemption — `sooth_market::redeem`.
 *
 * Per the EVM `TruthMarket.getRedemptionValue` payout table:
 *   YES wins:  burn user's YES, pay 1 USDC per share
 *   NO  wins:  burn user's NO,  pay 1 USDC per share
 *   INVALID:   burn both,        pay 0.5 USDC per share, summed
 *
 * The on-chain handler (sooth_market/src/instructions/redeem.rs) reads the
 * user's outcome ATA balances and resolves the math directly — no per-call
 * arg beyond the market reference. Builds via the SDK's existing
 * `buildClaim({kind: "redeem"})` branch and submits through the same
 * pipeline trade/claim use.
 *
 * Args:
 *   args[0]: market reference — `0x<base58>` or `sol:<base58>`
 */
async function dispatchRedeem(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "redeem");
  const args = call.args ?? [];
  const marketRef = toMarketRef(args[0]);
  if (!marketRef) {
    throw new Error("redeem: invalid market reference");
  }

  const req = await ctx.adapter.buildClaim(marketRef, {
    outcome: 0, // unused on Solana redeem path; placeholder for ClaimArgs shape
    user: `sol:${userBase58}`,
    kind: "redeem",
  });
  return submitAndSynth(ctx.adapter, req, signer);
}

/**
 * Operator: request_lock — adjudicator authority drives Market.lifecycle
 * Open → Locked. CPI'd into sooth_market::lock_for_resolution. Caller
 * must be Adjudicator.authority for the target market (set at
 * register_adjudicator time).
 *
 * Args:
 *   args[0]: market reference — `0x<base58>` or `sol:<base58>`
 */
async function dispatchRequestLock(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "requestLock");
  const args = call.args ?? [];
  const marketRef = toMarketRef(args[0]);
  if (!marketRef) {
    throw new Error("requestLock: invalid market reference");
  }
  const req = await ctx.adapter.buildRequestLock(marketRef, {
    user: `sol:${userBase58}`,
  });
  return submitAndSynth(ctx.adapter, req, signer);
}

/**
 * Operator: attest_outcome — adjudicator authority drives
 * Market.lifecycle Locked → Settled with the chosen winning_outcome.
 * CPI'd into sooth_market::settle.
 *
 * Args:
 *   args[0]: market reference — `0x<base58>` or `sol:<base58>`
 *   args[1]: winning outcome — 0 (NO), 1 (YES), 2 (INVALID)
 */
async function dispatchAttestOutcome(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "attestOutcome");
  const args = call.args ?? [];
  const marketRef = toMarketRef(args[0]);
  if (!marketRef) {
    throw new Error("attestOutcome: invalid market reference");
  }
  const outcome = Number(args[1] ?? -1);
  if (![0, 1, 2].includes(outcome)) {
    throw new Error(
      `attestOutcome: winningOutcome must be 0/1/2, got ${args[1]}`,
    );
  }
  const req = await ctx.adapter.buildAttestOutcome(marketRef, {
    user: `sol:${userBase58}`,
    winningOutcome: outcome as 0 | 1 | 2,
  });
  return submitAndSynth(ctx.adapter, req, signer);
}

/**
 * `settle(address market)` — the EVM signature the Operator page already
 * calls after `vetoEndsAt`. Solana matches it now: permissionless, no outcome
 * argument (the winning outcome is read from the AdjudicatorEntry, so a
 * caller cannot settle something other than what was attested or vetoed).
 *
 * Reverts with `VetoWindowOpen` until the guardian-veto window closes.
 *
 * Args:
 *   args[0]: market reference — `0x<base58>` or `sol:<base58>`
 */
async function dispatchSettle(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "settle");
  const args = call.args ?? [];
  const marketRef = toMarketRef(args[0]);
  if (!marketRef) {
    throw new Error("settle: invalid market reference");
  }
  const req = await ctx.adapter.buildSettle(marketRef, {
    user: `sol:${userBase58}`,
  });
  return submitAndSynth(ctx.adapter, req, signer);
}

/**
 * `bookPlace(market, side, limitTick, amount, matchLimit, postRemainder)`
 *
 * One instruction. No planner, no simulator, no per-fill account bundles — the
 * program walks its own book, so nothing is predicted off-chain and there is
 * nothing to go stale between planning and landing (audit finding H1).
 */
/**
 * One decoded book per market, cached briefly.
 *
 * `useOrderbook` walks 999 ticks per side through a multicall. Fetching the
 * account for each would be 1,998 RPC calls per poll; this collapses them to
 * one. The TTL is short because the ladder polls every 10s and a stale book is
 * worse than a slow one.
 *
 * A missing book (market created before the redesign, or never initialised)
 * caches as `null` so the miss is not retried 1,998 times either.
 */
const BOOK_CACHE_TTL_MS = 2_000;

/**
 * Single-flight cache. Stores the in-flight PROMISE, not the resolved value.
 *
 * That distinction is the whole point. `useOrderbook.scanTickDepth` issues its
 * 999 tick reads through a multicall, i.e. CONCURRENTLY — so a cache keyed on
 * the resolved value is checked by all 999 before any of them resolves, every
 * one misses, and the shim fires ~2,000 RPC calls per poll. On a local
 * validator that reads as the market list hanging forever.
 *
 * Caching the promise means the first caller starts the fetch and the other 998
 * await the same one.
 */
const bookCache = new Map<
  string,
  {
    at: number;
    inflight: Promise<Awaited<ReturnType<SolanaChainAdapter["readBook"]>> | null>;
  }
>();

/** Clear the book cache. Exported for tests, which need each case to start
 *  from a cold cache to observe fetch counts. */
export function __resetBookCache(): void {
  bookCache.clear();
}

async function readBookCached(
  ctx: AmmBridgeCtx,
  marketRef: string,
): Promise<Awaited<ReturnType<SolanaChainAdapter["readBook"]>> | null> {
  const hit = bookCache.get(marketRef);
  if (hit && Date.now() - hit.at < BOOK_CACHE_TTL_MS) return hit.inflight;

  // A market with no book — created before the redesign, or never
  // book_init'd — resolves to null rather than rejecting, so the miss is
  // cached too and not retried 999 times.
  const inflight = ctx.adapter.readBook(marketRef).catch(() => null);
  bookCache.set(marketRef, { at: Date.now(), inflight });
  return inflight;
}

async function dispatchBookPlace(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "bookPlace");
  const args = call.args ?? [];
  const marketRef = toMarketRef(args[0]);
  if (!marketRef) throw new Error("bookPlace: invalid market reference");

  const side = Number(args[1] ?? -1);
  if (side !== 0 && side !== 1) {
    throw new Error(`bookPlace: side must be 0 (bid) or 1 (ask), got ${args[1]}`);
  }
  const limitTick = Number(args[2] ?? 0);
  const req = await ctx.adapter.buildBookPlace(marketRef, {
    user: `sol:${userBase58}`,
    side,
    limitTick,
    amount: BigInt((args[3] ?? 0) as string | number | bigint),
    matchLimit: Number(args[4] ?? 8),
    postRemainder: Boolean(args[5] ?? true),
  });
  return submitAndSynth(ctx.adapter, req, signer);
}

/** `bookCancel(market, orderSeq)` — a real sequence, not a synthesised id. */
async function dispatchBookCancel(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "bookCancel");
  const args = call.args ?? [];
  const marketRef = toMarketRef(args[0]);
  if (!marketRef) throw new Error("bookCancel: invalid market reference");
  const userRef = `sol:${userBase58}`;
  const cancel = await ctx.adapter.buildBookCancel(marketRef, {
    user: userRef,
    orderSeq: BigInt((args[1] ?? 0) as string | number | bigint),
  });

  // Cancel AND withdraw, in one transaction.
  //
  // `book_cancel` refunds escrow to the trader's seat inside the book, not to
  // their wallet. That split is deliberate — it is what keeps a fill free of
  // token movement, so a transaction touches the vault at most twice however
  // many orders it crosses or cancels. But for a single cancel from the UI it
  // meant the money left the wallet on place and did not come back, which
  // reads as funds lost.
  //
  // Composing the two instructions keeps the batching property (a multi-cancel
  // still nets to one transfer) while making a single cancel whole again in
  // one signature. Withdraw is the MAIN instruction with cancel ahead of it in
  // `preIxs`, because pre-instructions run first and the credit has to exist
  // before it can be drained.
  try {
    const withdraw = await ctx.adapter.buildBookWithdraw(marketRef, {
      user: userRef,
    });
    const cancelMeta = cancel.meta as {
      ixProgramId: string;
      ixKeys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
      ixData: string;
    };
    const composed = {
      ...withdraw,
      meta: {
        ...(withdraw.meta as Record<string, unknown>),
        preIxs: [
          {
            programId: cancelMeta.ixProgramId,
            keys: cancelMeta.ixKeys,
            data: cancelMeta.ixData,
          },
          ...((withdraw.meta as { preIxs?: unknown[] }).preIxs ?? []),
        ],
        operation: "bookCancel",
      },
    } as typeof cancel;
    return await submitAndSynth(ctx.adapter, composed, signer);
  } catch (err) {
    // If the composed form fails for any reason, the cancel itself must still
    // go through — leaving the order resting would be strictly worse than
    // leaving the refund in seat credit, which the Withdraw button recovers.
    void err;
    return submitAndSynth(ctx.adapter, cancel, signer);
  }
}

/** `bookWithdraw(market)` — move seat credit into the wallet. */
async function dispatchBookWithdraw(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "bookWithdraw");
  const args = call.args ?? [];
  const marketRef = toMarketRef(args[0]);
  if (!marketRef) throw new Error("bookWithdraw: invalid market reference");
  const req = await ctx.adapter.buildBookWithdraw(marketRef, {
    user: `sol:${userBase58}`,
  });
  return submitAndSynth(ctx.adapter, req, signer);
}

async function dispatchDismissMarket(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "dismissMarket");
  const args = call.args ?? [];
  const marketRef = toMarketRef(args[0]);
  if (!marketRef) {
    throw new Error("dismissMarket: invalid market reference");
  }
  const req = await ctx.adapter.buildDismissMarket(marketRef, {
    user: `sol:${userBase58}`,
  });
  return submitAndSynth(ctx.adapter, req, signer);
}

async function dispatchClaimRefund(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "claimRefund");
  const args = call.args ?? [];
  const marketRef = toMarketRef(args[0]);
  if (!marketRef) {
    throw new Error("claimRefund: invalid market reference");
  }
  const req = await ctx.adapter.buildClaimRefund(marketRef, {
    user: `sol:${userBase58}`,
  });
  return submitAndSynth(ctx.adapter, req, signer);
}

async function dispatchRedeemLp(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "redeemLp");
  const args = call.args ?? [];
  const marketRef = toMarketRef(args[0]);
  if (!marketRef) {
    throw new Error("redeemLp: invalid market reference");
  }
  const lpAmount =
    typeof args[1] === "bigint" ? args[1] : BigInt((args[1] as any) ?? 0);
  if (lpAmount <= 0n) {
    throw new Error("redeemLp: lpAmount must be positive");
  }
  const req = await ctx.adapter.buildRedeemLp(marketRef, {
    user: `sol:${userBase58}`,
    lpAmount,
  });
  return submitAndSynth(ctx.adapter, req, signer);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// ─── sooth_book orderbook dispatch ──────────────────────────────────────────
//
// Upstream's `useOrderbookTrade.placeOrder` calls `writeContractAsync` with
// EVM ABI signatures that pre-date the Solana fork:
//
//   buyYes(marketKey, tick, shares, escrow, matchLimit)
//   buyNo (marketKey, tick, shares, escrow, matchLimit)
//   cancel(marketKey, side, tick)
//   cancelById(orderId)
//
// `marketKey` is the FNV-1a folding of `marketAddress` produced by
// `viem-shim.keccak256` — it's a deterministic identifier, but not invertible
// to the underlying sooth_market PDA. We therefore source the active market
// from `ctx.marketRef` (set by `DemoContext.marketRef` during page mount).
//
// Outcome encoding:
//   - The hook inverts EVM's outcome convention internally
//     (see useOrderbookTrade.ts:482-485 — outcome===0 calls buyYes,
//     outcome===1 calls buyNo). The hook never exposes the raw outcome
//     enum to the shim layer.
//   - `buyYes` therefore means "place an order requesting YES shares"
//     → on Solana, sooth_book seeds `MarketOutcome` index 0 = YES,
//       so we pass `side=1` (BuyArgs convention: 1=YES) and the SDK
//       adapter maps that to outcomeIndex=0.
//   - `buyNo`  → `side=0` (BuyArgs: 0=NO) → adapter outcomeIndex=1.
//
// Sell path: upstream's hook collapses sell-YES into "buyNo at oppositeTick"
// (and sell-NO into "buyYes at oppositeTick") by submitting the inverted-side
// purchase against the resting ask.
async function dispatchOrderbookWrite(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const fn = call.functionName ?? "";
  const { signer, userBase58 } = requireWallet(ctx, fn);

  if (!ctx.marketRef) {
    throw new Error(
      `${fn}: no active marketRef on chain-shim ctx — orderbook writes need DemoContext.marketRef`,
    );
  }
  const args = (call.args ?? []) as readonly unknown[];

  if (fn === "cancelById") {
    const raw = args[0];
    const orderId =
      typeof raw === "bigint"
        ? raw
        : typeof raw === "string" && /^\d+$/.test(raw)
          ? BigInt(raw)
          : null;
    if (orderId == null) {
      throw new Error(
        "cancelById: Solana orderbook expects a decimal composite order_id",
      );
    }
    const decoded = decodeCompositeOrderId(orderId);
    const req = await ctx.adapter.buildOrderbookCancel(
      ctx.marketRef,
      decoded.side,
      decoded.tick,
      { user: `sol:${userBase58}`, byId: orderId },
    );
    return submitAndSynth(ctx.adapter, req, signer);
  }

  if (fn === "cancel") {
    const sideRaw = args[1];
    const tickRaw = args[2];
    const side = (Number(sideRaw) === 1 ? 1 : 0) as 0 | 1;
    const tickArg =
      typeof tickRaw === "number" ? tickRaw : Number(tickRaw ?? 0);
    if (!Number.isFinite(tickArg) || tickArg < 1 || tickArg > 999) {
      throw new Error(
        `cancel: invalid tick ${String(tickRaw)} (expected 1..999)`,
      );
    }
    const req = await ctx.adapter.buildOrderbookCancel(
      ctx.marketRef,
      side,
      tickArg,
      { user: `sol:${userBase58}` },
    );
    return submitAndSynth(ctx.adapter, req, signer);
  }

  // buyYes / buyNo path. EVM args: `[marketKey, tick, shares, escrow, matchLimit]`.
  const tickRaw = args[1];
  const sharesRaw = args[2];
  const tick = typeof tickRaw === "number" ? tickRaw : Number(tickRaw ?? 0);
  if (!Number.isFinite(tick) || tick < 1 || tick > 999) {
    throw new Error(`${fn}: invalid tick ${String(tickRaw)} (expected 1..999)`);
  }
  // Upstream packs shares as 18-decimal WAD (`parseUnits(amount, 18)`); W7
  // sooth_book stores inline order amounts in the same WAD unit.
  const sharesWad =
    typeof sharesRaw === "bigint"
      ? sharesRaw
      : BigInt((sharesRaw as { toString(): string })?.toString() ?? "0");
  if (sharesWad <= 0n) {
    throw new Error(`${fn}: shares must be positive`);
  }

  // Outcome encoding (see header comment for the full rationale).
  // BuyArgs.side: 0=NO, 1=YES.
  const side: 0 | 1 = fn === "buyYes" ? 1 : 0;
  const rawLimit =
    typeof args[4] === "number"
      ? args[4]
      : Number((args[4] as { toString(): string })?.toString() ?? 0);
  const matchLimitPerTx =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), DEFAULT_MATCH_LIMIT_PER_TX)
      : DEFAULT_MATCH_LIMIT_PER_TX;
  const user = `sol:${userBase58}`;
  const escrow = typeof args[3] === "boolean" ? args[3] : false;

  let lastSignature = "";
  const { batchesSubmitted } = await submitOrderbookBuyMultiTx(
    ctx.adapter,
    ctx.marketRef,
    { side, tick, amount: sharesWad, escrow, matchLimitPerTx, user },
    async (ixs) => {
      const receipt = await ctx.adapter.submit(
        requestFromInstructions(ixs, userBase58),
        signer,
      );
      lastSignature = receipt.txId.replace(/^sol:/, "");
    },
  );
  if (batchesSubmitted > 0) {
    return synthHashFromSignature(lastSignature);
  }

  const req = await ctx.adapter.buildOrderbookBuy(ctx.marketRef, {
    side,
    tick,
    amount: sharesWad,
    escrow,
    matchLimit: matchLimitPerTx,
    user,
  } as never);

  return submitAndSynth(ctx.adapter, req, signer);
}

function decodeSolMarketRef(ref: string): PublicKey {
  const stripped = ref.startsWith("sol:") ? ref.slice(4) : ref;
  return new PublicKey(stripped);
}

/**
 * Coerce one of the address-shaped values upstream code passes through the
 * shim into a Solana-compatible `MarketRef` (`sol:<base58>`).
 *
 * Accepts: `sol:<base58>`, raw `<base58>`, or `0x<base58>` (the synthetic
 * shape the wagmi-shim's `useAccount` produces).
 */
export function toMarketRef(v: unknown): string | undefined {
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

/**
 * Common pre-check for write dispatchers: an active signer + connected
 * wallet pubkey are both required. Throws op-named errors so toast UX
 * stays informative; returns the values narrowed to non-undefined.
 */
function requireWallet(
  ctx: AmmBridgeCtx,
  op: string,
): { signer: SignerRef; userBase58: string } {
  if (!ctx.signer) {
    throw new Error(
      `${op}: no Solana signer available — connect a wallet first`,
    );
  }
  if (!ctx.userBase58) {
    throw new Error(`${op}: no Solana wallet pubkey — connect a wallet first`);
  }
  return { signer: ctx.signer, userBase58: ctx.userBase58 };
}

function decodeCompositeOrderId(orderId: bigint): { side: 0 | 1; tick: number } {
  if (orderId < 0n || orderId > 0xffffffffffffffffn) {
    throw new Error(`cancelById: order_id must fit in u64, got ${orderId}`);
  }
  const side = Number((orderId >> 56n) & 0xffn);
  const tick = Number((orderId >> 40n) & 0xffffn);
  if (side !== 0 && side !== 1 || tick < 1 || tick > 999) {
    throw new Error(
      `cancelById: composite order_id encodes invalid side/tick (${side}, ${tick})`,
    );
  }
  return { side, tick };
}

function requestFromInstructions(
  ixs: TransactionInstruction[],
  userBase58: string,
): SoothRequest {
  if (ixs.length === 0) {
    throw new Error("orderbook multi-tx batch contained no instructions");
  }
  const main = ixs[ixs.length - 1]!;
  const preIxs = ixs.slice(0, -1).map(serializeIxForSubmit);
  return {
    kind: "orderbook",
    accounts: main.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    meta: {
      userPk: userBase58,
      ixData: Buffer.from(main.data).toString("base64"),
      ixKeys: main.keys.map((k) => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      ixProgramId: main.programId.toBase58(),
      preIxs,
    },
  };
}

function serializeIxForSubmit(ix: TransactionInstruction): {
  programId: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
} {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(ix.data).toString("base64"),
  };
}

/**
 * Standard tail of a write dispatcher: submit the SoothRequest and convert
 * the resulting `sol:<sig>` txId into the synthetic 0x-hex Hash that
 * upstream's wagmi-shaped writeContract callers expect.
 */
async function submitAndSynth(
  adapter: SolanaChainAdapter,
  req: SoothRequest,
  signer: SignerRef,
): Promise<string> {
  const receipt = await adapter.submit(req, signer);
  return synthHashFromSignature(receipt.txId.replace(/^sol:/, ""));
}
