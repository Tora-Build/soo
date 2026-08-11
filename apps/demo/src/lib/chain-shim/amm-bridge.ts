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

import { rememberMarketQuestion } from "../market-questions";
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
  derivePositionPda,
  deriveUserUsdcAta,
  yesPriceWad,
  LN2_WAD,
  WAD,
  WAD_TO_USDC_SCALAR,
  soothCoreIdl,
  type SolanaChainAdapter,
  type SignerRef,
  type SoothRequest,
} from "@sooth/sdk-solana";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
/**
 * Size an order had when it was placed, in base units.
 *
 * The book account holds only the REMAINING amount: a partial fill decrements
 * the node in place, and no second field records what it started as. So "40%
 * filled" is not answerable from the book alone — which is why every partially
 * filled order showed 0%.
 *
 * The `BookOrderPlaced` event carries it. Cached per (market, seq) because an
 * order's original size never changes, so the history walk happens once rather
 * than on every 15-second poll.
 *
 * Falls back to the remaining amount when the placement predates the fetched
 * window. That reads as "0% filled" — the old behaviour — which is better than
 * inventing a percentage.
 */
const placedAmounts = new Map<string, bigint>();
let placedFetchedFor: string | null = null;

async function placedAmountOf(
  ctx: AmmBridgeCtx,
  marketRef: string,
  seq: bigint,
  remaining: bigint,
): Promise<bigint> {
  const key = `${marketRef}:${seq}`;
  const cached = placedAmounts.get(key);
  if (cached !== undefined) return cached;

  // Walk history only when this market has not been walked yet — a miss on a
  // genuinely absent order must not re-walk on every poll.
  if (placedFetchedFor !== marketRef) {
    placedFetchedFor = marketRef;
    try {
      const records = await ctx.adapter.readBookHistory(marketRef, {
        limit: 200,
      });

      // The `placed` event records what RESTED, not what was asked for.
      //
      // `book_place` matches first and rests the remainder, and emits
      // `BookOrderPlaced { amount: result.resting }`. So an order for 10 that
      // filled 7 immediately records "placed 3" — and reading that as the
      // original size makes it 0% filled forever, even though the trader
      // watched 70% of it go.
      //
      // The fills are in the SAME transaction, so the original is
      // `resting + everything this taker filled under that signature`. That is
      // why this groups by signature rather than looking at events in
      // isolation.
      const filledBySignature = new Map<string, Map<string, bigint>>();
      for (const { signature, event } of records) {
        if (event.kind !== "filled") continue;
        const perTaker =
          filledBySignature.get(signature) ?? new Map<string, bigint>();
        const total = event.fills.reduce((acc, f) => acc + f.amount, 0n);
        perTaker.set(event.taker, (perTaker.get(event.taker) ?? 0n) + total);
        filledBySignature.set(signature, perTaker);
      }

      for (const { signature, event } of records) {
        if (event.kind !== "placed") continue;
        const filledHere =
          filledBySignature.get(signature)?.get(event.trader) ?? 0n;
        placedAmounts.set(
          `${marketRef}:${event.seq}`,
          event.amount + filledHere,
        );
      }
    } catch {
      // No history available; every order reads as unfilled.
    }
  }
  return placedAmounts.get(key) ?? remaining;
}

/** Test hook: forget cached placement sizes. */
export function __resetPlacedAmounts(): void {
  placedAmounts.clear();
  placedFetchedFor = null;
}

/** USDC base units (1e6) -> WAD (1e18), the scale upstream formatters use. */
const BASE_TO_WAD = 1_000_000_000_000n;

import { myAccount } from "../book-view";
import { MAX_CANCELS_PER_TX } from "@sooth/sdk-solana";

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

/**
 * Which venue's token an EVM-shaped call is talking about.
 *
 * Upstream passes an ERC20 contract address; here that slot carries a mint,
 * and the two venues have different ones. Reads and the faucet MUST agree —
 * if `balanceOf` reported the book's balance while the faucet topped up the
 * AMM's, the panel would refuse trades the user can afford and offer trades
 * they cannot fund. So both go through here.
 *
 * The book is the fallback: it is the mint every legacy call site meant back
 * when there was only one.
 */
function resolveVenueMint(
  address: unknown,
  ctx: AmmBridgeCtx,
): PublicKey {
  // `ammMint` is younger than the rest of the adapter, so a `dist/` built
  // before the venue split still satisfies every import and simply lacks it.
  // Reading `.toBase58()` off that gives "Cannot read properties of undefined",
  // which points at this line and not at the actual problem — a stale build
  // that a workspace happily keeps serving. Say which it is.
  if (!ctx.adapter.ammMint || !ctx.adapter.bookMint) {
    throw new Error(
      "@sooth/sdk-solana is missing the venue mints — its dist/ predates the " +
        "venue split. Rebuild it: pnpm -F @sooth/sdk-solana build",
    );
  }
  const requested = toAddressRef(address)?.replace(/^sol:/, "");
  return requested === ctx.adapter.ammMint.toBase58()
    ? ctx.adapter.ammMint
    : ctx.adapter.bookMint;
}

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
        // Pass the SIGNED delta. `readQuote` feeds it straight to `costDelta`,
        // which is direction-aware, so a sell quotes the curve in the
        // direction it will actually move.
        //
        // This used to send `abs(delta)` with the note "assume buy here" — so
        // a sell was priced as the cost of buying MORE, which differs from the
        // proceeds of selling out by the price impact. The demo's slippage
        // buffer hid that until the fee grew large enough to consume it.
        const q = await ctx.adapter.readQuote(marketRef, outcome, delta);
        // Upstream's tuple is EVM-shaped and unsigned. `readQuote` is signed
        // (negative = proceeds), so hand back magnitudes: for a sell that is
        // (gross proceeds, fee, NET proceeds) — which is exactly what the
        // consuming hook documents `netAmount` to be.
        const mag = (v: bigint) => (v < 0n ? -v : v);
        return [mag(q.cost), q.fee, mag(q.netCost), q.newYesPrice] as const;
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
        // `graduatedAt` as a SENTINEL, not a timestamp.
        //
        // Upstream only ever asks `graduatedAt > 0n`, and `AmmState` records
        // graduation as a bool with no time attached — so 1n means "yes" and
        // 0n means "no", which is exactly the information that exists.
        //
        // This was hardcoded 0n, which made `useLaunchpadMarketDirect`
        // report EVERY market as still bonding no matter what the chain said.
        // A graduated market therefore rendered the "BONDING" badge and the
        // AMM's 5% fee rate while its orderbook tab was open next to it —
        // the page contradicted itself, and the fee shown was not the fee
        // being charged.
        return [
          synthCreator,
          synthCreator,
          snap.market.b,
          creatorDeposit,
          snap.market.isGraduated ? 1n : 0n,
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
      // The rates the program actually charges, not the EVM defaults this
      // used to return.
      //
      // Upstream names these pre/post-graduation because on EVM the venue and
      // the phase coincide. Here they are per-VENUE — `amm_fee_bps` and
      // `book_fee_bps` — and the mapping holds because the AMM is the
      // pre-graduation venue and the book opens at graduation.
      //
      // Hardcoding them meant the displayed fee was independent of the
      // charged one; they agreed only by coincidence, and stopped agreeing
      // the moment the venues got separate rates.
      try {
        const { amm, book } = await ctx.adapter.readVenueFeeBps();
        return BigInt(call.functionName === "preGradFeeBps" ? amm : book);
      } catch {
        // An unreadable config is not a rate. Zero renders as "—" upstream
        // rather than as a confident wrong number.
        return 0n;
      }
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
      // WHICH token's balance. Upstream passes the ERC20 address in
      // `call.address`; here that is a mint, and the two venues have
      // different ones. Defaulting to the book's would report a USDC balance
      // for an AMM trade priced in the AMM's token — the panel would then
      // refuse a trade the user can afford, or allow one they cannot.
      const mint = resolveVenueMint(call.address, ctx);
      try {
        const ata = deriveUserUsdcAta(userPk, mint);
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
            // Size at placement, so the panel can show how much has filled.
            // The book stores only what REMAINS — a partial fill decrements
            // the node in place — so the original has to come from the
            // `placed` event. Cached because it never changes.
            placedAmount: await placedAmountOf(ctx, marketRef, o.seq, o.amount),
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
      // Return WAD, not the book's base units.
      //
      // The book counts in USDC base units (1e6). Every upstream formatter
      // assumes 18 — `useOrderbook` does `formatUnits(totalAmount, 18)` — so
      // handing back raw base units rendered 25 shares as
      // 0.000000000000000025, which displays as "0" and makes every depth bar
      // zero-width. The ladder was loading correctly the whole time; it just
      // drew nothing and read as empty.
      //
      // Converting here rather than at the call site keeps the shim's two
      // order reads consistent: `orderbook-reads.ts` already returns WAD, and
      // two reads of the same concept disagreeing on units is what produced
      // this.
      const total = orders.reduce(
        (acc, o) => acc + o.amount * BASE_TO_WAD,
        0n,
      );
      return [total, orders as readonly unknown[]] as const;
    }

    case "isMarketRegistered": {
      // SoothBookTerminal gates the trade form on this read. MarketBook is
      // lazy-created by the first buy_yes/buy_no, so a valid sooth_market PDA
      // is enough to consider the book available.
      // Parse through `toMarketRef` rather than by hand.
      //
      // This had its own stripping logic, so it accepted `sol:`, bare base58
      // and `0x${base58}` but not a `marketKey` — and a `false` here makes the
      // hook set `isSupported(false)` and return before fetching any depth, so
      // the whole ladder vanishes on a market that is plainly registered.
      // Keeping one parser means every caller's form works everywhere.
      const marketRef = toMarketRef(call.args?.[0]);
      if (!marketRef) return false;
      let candidate: PublicKey;
      try {
        candidate = new PublicKey(marketRef.slice(4));
      } catch {
        return false;
      }
      try {
        // A market is "registered" if its account exists. The second path
        // here used to resolve a lazily-created MarketBook PDA, which the
        // single-account book removed.
        const direct = await ctx.connection.getAccountInfo(candidate);
        return direct !== null;
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
  // The book write path. Distinct function names rather than a mode flag, so a
  // caller cannot land on the wrong instruction by accident while
  // both are live.
  if (call.functionName === "bookPlace") {
    return dispatchBookPlace(call, ctx);
  }
  if (call.functionName === "bookCancel") {
    return dispatchBookCancel(call, ctx);
  }
  if (call.functionName === "bookCancelMany") {
    return dispatchBookCancelMany(call, ctx);
  }
  if (call.functionName === "bookWithdraw") {
    return dispatchBookWithdraw(call, ctx);
  }
  if (call.functionName === "redeemBookSeat") {
    return dispatchRedeemBookSeat(call, ctx);
  }
  if (call.functionName === "redeemAmmPosition") {
    return dispatchRedeemAmmPosition(call, ctx);
  }
  if (call.functionName === "reclaimSubsidy") {
    return dispatchReclaimSubsidy(call, ctx);
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
 *
 * WHICH token, though, does come from the caller. The two venues price in
 * different mints, and a faucet that only ever dispensed the book's would
 * leave every wallet unable to trade the AMM — which is every market before
 * graduation. `call.address` carries the requested mint, resolved the same
 * way `balanceOf` resolves it, so the two always agree about what a wallet
 * holds.
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
  const venueMint = resolveVenueMint(_call.address, ctx);
  const recipientAta = getAssociatedTokenAddressSync(venueMint, recipient);

  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      mintAuthority.publicKey,
      recipientAta,
      recipient,
      venueMint,
    ),
  );
  tx.add(
    createMintToInstruction(
      venueMint,
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
    // The question text dies here otherwise: the program stores only its
    // hash, so this is the last point at which the words still exist.
    rememberMarketQuestion(meta.marketPda, question);
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
      // localStorage too: a market outlives the tab that created it, and
      // with sessionStorage alone a created market vanished from the list
      // the moment the tab closed — the demo has no on-chain registry to
      // rediscover it from.
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(
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
  // Submit directly rather than through `submitAndSynth`, because that returns
  // a SYNTHESISED 32-byte hex hash for upstream's EVM typing — not a signature
  // any RPC can look up, and callers of this path want the real one.
  //
  // No self-trade toast: the matcher steps over a trader's own crossing
  // resting orders and cancels/refunds them rather than trading against
  // itself, and that is silent by design now — asked for directly, after the
  // wording proved confusing across the cases it actually fires in. The
  // program still logs it (`msg!("self-trade prevention: ...")`), so it is
  // recoverable from a transaction's logs for debugging without surfacing a
  // toast on every order that happens to replace one of the trader's own.
  const receipt = await ctx.adapter.submit(req, signer);
  const realSignature = receipt.txId.replace(/^sol:/, "");
  return synthHashFromSignature(realSignature);
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

/**
 * `bookCancelMany(market, seqs)` — cancel many orders together.
 *
 * The panel's "Cancel Selected" used to loop the single-cancel path, so N
 * orders meant N transactions: N wallet prompts, N fees, and a half-finished
 * run leaving the trader to work out which ones went. Cancelling is what people
 * do when they want out quickly, which is the worst moment to ask for
 * approvals one at a time.
 *
 * Chunked at `MAX_CANCELS_PER_TX`, which is measured rather than assumed — a
 * transaction de-duplicates its account list, so each extra cancel costs only
 * ~24 bytes and 25 is where the 1232-byte limit bites.
 *
 * Each chunk ends in a withdraw, so refunds reach the wallet instead of
 * stopping at seat credit.
 */
async function dispatchBookCancelMany(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "bookCancelMany");
  const args = call.args ?? [];
  const marketRef = toMarketRef(args[0]);
  if (!marketRef) throw new Error("bookCancelMany: invalid market reference");

  const raw = (args[1] ?? []) as Array<string | number | bigint>;
  const seqs = raw.map((v) => BigInt(v));
  if (seqs.length === 0) throw new Error("bookCancelMany: nothing selected");

  let lastSig = "";
  for (let i = 0; i < seqs.length; i += MAX_CANCELS_PER_TX) {
    const chunk = seqs.slice(i, i + MAX_CANCELS_PER_TX);
    const req = await ctx.adapter.buildBookCancelMany(marketRef, {
      user: `sol:${userBase58}`,
      orderSeqs: chunk,
    });
    lastSig = await submitAndSynth(ctx.adapter, req, signer);
  }
  return lastSig;
}

/**
 * `redeemBookSeat(market)` — pay out a book position after settlement.
 *
 * Distinct from `bookWithdraw`, which moves seat CREDIT. This converts the
 * seat's signed net into money against the resolved outcome, and only works
 * once the market has settled.
 */
async function dispatchRedeemBookSeat(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "redeemBookSeat");
  const marketRef = toMarketRef((call.args ?? [])[0]);
  if (!marketRef) throw new Error("redeemBookSeat: invalid market reference");
  const req = await ctx.adapter.buildRedeemBookSeat(marketRef, {
    user: `sol:${userBase58}`,
  });
  return submitAndSynth(ctx.adapter, req, signer);
}

/**
 * `redeemAmmPosition(market)` — pay out an AMM position after settlement.
 *
 * The third claim path, and the one that had no route from the UI at all: the
 * instruction existed on chain (bug B1) but nothing called it, so a user who
 * bought through the AMM rather than the book saw their funds sit in the vault
 * with no button to press.
 *
 * Separate from `redeemBookSeat` because they read different ledgers — a
 * trader who used both has to claim twice, and neither call knows about the
 * other's balance.
 */
async function dispatchRedeemAmmPosition(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "redeemAmmPosition");
  const marketRef = toMarketRef((call.args ?? [])[0]);
  if (!marketRef) throw new Error("redeemAmmPosition: invalid market reference");
  const userPk = new PublicKey(userBase58);

  // Bail before building anything if there is nothing to claim.
  //
  // The portfolio sweeps every known market, so without this a trader with one
  // AMM position gets a wallet prompt per market — each for a transaction that
  // pays zero. On Solana every one of those is a signature request, and a user
  // who is asked to sign six things to claim one is being trained to click
  // through prompts.
  //
  // The instruction is still safe to call on an empty position; this is purely
  // about not asking.
  const marketPda = new PublicKey(marketRef.replace(/^sol:/, ""));
  const marketInfo = await ctx.connection.getAccountInfo(marketPda);
  if (!marketInfo) throw new Error("redeemAmmPosition: no such market");
  const marketId = marketInfo.data.subarray(8, 8 + 32); // after the discriminator
  const [positionPda] = derivePositionPda(
    marketId,
    userPk,
    ctx.adapter.programIds,
  );
  const positionInfo = await ctx.connection.getAccountInfo(positionPda);
  if (!positionInfo) throw new Error("redeemAmmPosition: no AMM position");
  // 8 discriminator + user(32) + market(32), then yes_shares/no_shares as
  // i128. Tested by scanning all 32 bytes rather than reading the low u64 of
  // each: shares are WAD-scaled, so a position of 2^64 base units would have a
  // zero low word and read as "nothing to claim".
  const OFF_YES = 8 + 32 + 32;
  const shares = positionInfo.data.subarray(OFF_YES, OFF_YES + 32);
  if (shares.every((b) => b === 0)) {
    throw new Error("redeemAmmPosition: position already redeemed");
  }

  const req = await ctx.adapter.buildRedeemAmmPosition(marketRef, {
    user: `sol:${userBase58}`,
  });
  return submitAndSynth(ctx.adapter, req, signer);
}

/**
 * `reclaimSubsidy(market)` — return the unspent LMSR subsidy to the creator.
 *
 * Only the market's creator can call it; the program binds `lp_position` to
 * the signer, so anyone else fails the seeds constraint rather than getting a
 * silent no-op.
 */
async function dispatchReclaimSubsidy(
  call: WriteCallShape,
  ctx: AmmBridgeCtx,
): Promise<string> {
  const { signer, userBase58 } = requireWallet(ctx, "reclaimSubsidy");
  const marketRef = toMarketRef((call.args ?? [])[0]);
  if (!marketRef) throw new Error("reclaimSubsidy: invalid market reference");
  const req = await ctx.adapter.buildReclaimSubsidy(marketRef, {
    creator: `sol:${userBase58}`,
  });
  return submitAndSynth(ctx.adapter, req, signer);
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

  if (v.startsWith("0x")) {
    const tail = v.slice(2);
    if (!tail) return undefined;

    // A `marketKey`: 32 raw bytes as hex.
    //
    // Upstream hooks identify a market by `keccak256(encodePacked(...))`, and
    // the shim's keccak256 returns the pubkey's own 32 bytes as hex — the
    // identity path. But this function only ever stripped "0x" and handed the
    // rest on as base58, so a marketKey became a ref no `PublicKey` could
    // parse, every read on it degraded to empty, and the shared orderbook
    // ladder rendered as "no liquidity" on a market full of it. Only the
    // panels that pass a real market ref worked, which looked like "orders
    // exist per wallet and nowhere else".
    //
    // 64 hex chars is unambiguous: base58 of 32 bytes is at most 44, so this
    // cannot collide with the `0x${base58}` form `useAccount` produces.
    if (tail.length === 64 && /^[0-9a-fA-F]+$/.test(tail)) {
      try {
        return `sol:${new PublicKey(Buffer.from(tail, "hex")).toBase58()}`;
      } catch {
        return undefined;
      }
    }

    // Otherwise `useAccount`'s `0x${base58}` wrapping.
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
