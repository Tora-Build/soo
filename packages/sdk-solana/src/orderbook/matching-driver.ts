import {
  PublicKey,
  type AccountMeta,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { bookSidePda, orderbookPositionPda, type ProgramIds } from "../pdas.js";
import type { AddressRef, MarketRef } from "../types.js";

export const NUM_TICKS = 1000;
export const MIN_TICK = 1;
export const MAX_TICK = 999;
/**
 * Fills attempted per transaction.
 *
 * Was 3, because the stock 32 KB BPF heap OOM'd at the 4th fill. sooth_core
 * now ships a 256 KB #[global_allocator], and the measured envelope is:
 *
 *   fills   CU        writable   bytes
 *   3       ~125k     16         943
 *   4       ~169k     19         1042
 *   5       ~189k     22         1141
 *   6       —         —          1240  ← over PACKET_DATA_SIZE (1232)
 *
 * So the hard ceiling is 5, set by transaction size — not compute (14% of
 * budget at 5) and not account locks. Each fill costs ~99 bytes.
 *
 * We default to 4 rather than 5 deliberately. Those measurements use the bare
 * compute-budget preamble; a real submit also carries a priority-fee
 * instruction and may prepend `initMarketFeePool`, which alone is far larger
 * than the ~91 bytes of headroom 5 fills would leave. 4 keeps ~190 bytes of
 * slack while still improving depth 33% over the old limit.
 *
 * Callers who know their transaction shape can pass `matchLimitPerTx: 5`.
 */
export const DEFAULT_MATCH_LIMIT_PER_TX = 4;

/** Hard ceiling: 6 fills serialize to 1240 bytes and are rejected on the
 *  wire. See tests/orderbook-cu-budget.test.ts. */
export const MAX_FILLS_PER_TX = 5;

/// Accounts appended per predicted fill: [book_side, maker_position, maker_usdc_ata].
/// MUST stay in sync with `FILL_BUNDLE_LEN` in
/// `programs/sooth-core/src/matching.rs` — the program rejects a
/// `remaining_accounts` length that is not a multiple of this with
/// `WrongBundleArity`, and mis-slices the bundles if the stride disagrees.
export const FILL_BUNDLE_LEN = 3;

export interface MatchTaker {
  side: 0 | 1;
  tick: number;
  amount: bigint;
  escrow: boolean;
}

export interface MatchSimulation {
  taker: MatchTaker;
  predictedFills: Array<{
    makerTick: number;
    makerOrderId: bigint;
    fillAmount: bigint;
  }>;
  remainingAmount: bigint;
  bundlesNeeded: number;
}

export interface MatchPlan extends MatchSimulation {
  marketState: OrderbookMarketSnapshot;
  fills: PredictedFill[];
}

export interface MarketBookSnapshot {
  bitmapFor: readonly (bigint | number)[];
  bitmapAgainst: readonly (bigint | number)[];
}

export interface InlineOrderSnapshot {
  id: bigint;
  maker: PublicKey;
  amount: bigint;
  escrow: boolean;
}

export interface BookSideSnapshot {
  side: 0 | 1;
  tick: number;
  headIndex: number;
  orders: readonly InlineOrderSnapshot[];
}

export interface OrderbookMarketSnapshot {
  marketPda: PublicKey;
  marketId: Uint8Array;
}

export interface BuildOrderbookBuyTxTaker extends MatchTaker {
  matchLimitPerTx: number;
  user?: AddressRef;
}

export interface SoothSolanaClient {
  programIds: ProgramIds;
  usdcMint: PublicKey;
  resolveOrderbookMarket(market: MarketRef): Promise<OrderbookMarketSnapshot>;
  fetchMarketBook(market: MarketRef): Promise<MarketBookSnapshot | null>;
  fetchBookSide(
    market: MarketRef,
    side: 0 | 1,
    tick: number,
  ): Promise<BookSideSnapshot | null>;
  buildOrderbookBuyTx(
    market: MarketRef,
    taker: BuildOrderbookBuyTxTaker,
    remainingAccounts: AccountMeta[],
  ): Promise<TransactionInstruction[]>;
}

interface PredictedFill {
  makerTick: number;
  makerOrderId: bigint;
  fillAmount: bigint;
  maker: PublicKey;
}

export async function simulateMatch(
  client: SoothSolanaClient,
  market: MarketRef,
  taker: MatchTaker,
): Promise<MatchSimulation> {
  const { fills, remainingAmount } = await planMatch(client, market, taker);
  return {
    taker: { ...taker },
    predictedFills: fills.map(({ makerTick, makerOrderId, fillAmount }) => ({
      makerTick,
      makerOrderId,
      fillAmount,
    })),
    remainingAmount,
    bundlesNeeded: fills.length,
  };
}

export async function planMatch(
  client: SoothSolanaClient,
  market: MarketRef,
  taker: MatchTaker,
): Promise<MatchPlan> {
  const { marketState, fills, remainingAmount } = await collectPredictedFills(
    client,
    market,
    taker,
  );
  return {
    marketState,
    fills,
    taker: { ...taker },
    predictedFills: fills.map(({ makerTick, makerOrderId, fillAmount }) => ({
      makerTick,
      makerOrderId,
      fillAmount,
    })),
    remainingAmount,
    bundlesNeeded: fills.length,
  };
}

/**
 * Submit a multi-transaction orderbook buy that crosses more makers than fit
 * in one transaction.
 *
 * Each batch is planned against the LIVE `BookSide.head_index` — read fresh
 * from chain — and submitted via `submit` BEFORE the next batch is planned, so
 * batch N+1 sees the book as it stands after batch N's fills advanced the head.
 *
 * This interleave is mandatory, not stylistic (audit finding H1). The previous
 * `buildOrderbookBuyMultiTx` prebuilt every batch in one loop and returned them
 * for the caller to submit afterwards. Because nothing landed between
 * iterations, `head_index` never moved, so every batch selected the SAME makers.
 * Once batch 1 landed, batch 2's bundles pointed at already-filled orders and
 * the matcher rejected them with `MakerAccountMismatch` (6052) — which broke
 * the documented "SDK does multi-tx for deeper crosses" mitigation for any
 * cross past `matchLimitPerTx`.
 *
 * Solana requires this dance because every account a transaction touches must
 * be named up front, so the maker list cannot be discovered mid-execution the
 * way EVM's `_match` walks a storage mapping.
 */
export async function submitOrderbookBuyMultiTx(
  client: SoothSolanaClient,
  market: MarketRef,
  taker: MatchTaker & { matchLimitPerTx: number; user?: AddressRef },
  submit: (ixs: TransactionInstruction[]) => Promise<unknown>,
): Promise<{ batchesSubmitted: number }> {
  const matchLimitPerTx =
    taker.matchLimitPerTx > 0
      ? Math.floor(taker.matchLimitPerTx)
      : DEFAULT_MATCH_LIMIT_PER_TX;
  if (matchLimitPerTx <= 0) return { batchesSubmitted: 0 };

  let remaining = taker.amount;
  let batchesSubmitted = 0;
  while (remaining > 0n) {
    const { marketState, fills } = await collectPredictedFills(client, market, {
      ...taker,
      amount: remaining,
    });
    if (fills.length === 0) break;

    const chunk = fills.slice(0, matchLimitPerTx);
    const isFinalChunk = fills.length < matchLimitPerTx;
    const chunkAmount = isFinalChunk
      ? remaining
      : chunk.reduce((sum, fill) => sum + fill.fillAmount, 0n);
    if (chunkAmount <= 0n) break;

    const remainingAccounts = buildFillBundles(
      marketState.marketId,
      (taker.side ^ 1) as 0 | 1,
      chunk,
      client,
    );
    const ixs = await client.buildOrderbookBuyTx(
      market,
      {
        side: taker.side,
        tick: taker.tick,
        amount: chunkAmount,
        escrow: taker.escrow,
        matchLimitPerTx,
        user: taker.user,
      },
      remainingAccounts,
    );
    // Submit before looping — the next collectPredictedFills() must observe
    // this batch's effect on head_index. See the H1 note above.
    await submit(ixs);
    batchesSubmitted += 1;
    remaining -= chunkAmount;

    if (chunk.length < matchLimitPerTx) break;
  }
  return { batchesSubmitted };
}

export function buildFillBundles(
  marketId: Uint8Array,
  oppSide: 0 | 1,
  fills: readonly PredictedFill[],
  client: Pick<SoothSolanaClient, "programIds" | "usdcMint">,
): AccountMeta[] {
  const accounts: AccountMeta[] = [];
  for (const fill of fills) {
    const [bookSide] = bookSidePda(marketId, oppSide, fill.makerTick, {
      soothCore: client.programIds.soothCore,
    });
    const [makerPosition] = orderbookPositionPda(marketId, fill.maker, {
      soothCore: client.programIds.soothCore,
    });
    const makerUsdcAta = getAssociatedTokenAddressSync(
      client.usdcMint,
      fill.maker,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    accounts.push(
      { pubkey: bookSide, isSigner: false, isWritable: true },
      { pubkey: makerPosition, isSigner: false, isWritable: true },
      { pubkey: makerUsdcAta, isSigner: false, isWritable: true },
    );
  }
  return accounts;
}

async function collectPredictedFills(
  client: SoothSolanaClient,
  market: MarketRef,
  taker: MatchTaker,
): Promise<{
  marketState: OrderbookMarketSnapshot;
  fills: PredictedFill[];
  remainingAmount: bigint;
}> {
  assertTaker(taker);
  const marketState = await client.resolveOrderbookMarket(market);
  const marketBook = await client.fetchMarketBook(market);
  if (!marketBook) {
    return { marketState, fills: [], remainingAmount: taker.amount };
  }

  const oppSide = (taker.side ^ 1) as 0 | 1;
  const bitmap = normalizeBitmap(
    oppSide === 1 ? marketBook.bitmapFor : marketBook.bitmapAgainst,
  );
  const minOppTick = NUM_TICKS - taker.tick;
  let oppTick = findNextDown(bitmap, NUM_TICKS);
  let remainingAmount = taker.amount;
  const fills: PredictedFill[] = [];

  while (
    remainingAmount > 0n &&
    oppTick >= minOppTick &&
    oppTick <= MAX_TICK
  ) {
    const side = await client.fetchBookSide(market, oppSide, oppTick);
    if (side?.side === oppSide && side.tick === oppTick) {
      let head = Math.max(0, Math.floor(side.headIndex));
      while (remainingAmount > 0n && head < side.orders.length) {
        const order = side.orders[head];
        if (!order || order.amount <= 0n) {
          head += 1;
          continue;
        }
        const fillAmount =
          remainingAmount < order.amount ? remainingAmount : order.amount;
        fills.push({
          makerTick: oppTick,
          makerOrderId: order.id,
          fillAmount,
          maker: order.maker,
        });
        remainingAmount -= fillAmount;
        head += order.amount === fillAmount ? 1 : 0;
        if (fillAmount === 0n) break;
      }
    }
    if (oppTick === 0) break;
    oppTick = findNextDown(bitmap, oppTick);
  }

  return { marketState, fills, remainingAmount };
}

function assertTaker(taker: MatchTaker): void {
  if (taker.side !== 0 && taker.side !== 1) {
    throw new Error(`taker.side must be 0 or 1, got ${String(taker.side)}`);
  }
  if (!Number.isInteger(taker.tick) || taker.tick < MIN_TICK || taker.tick > MAX_TICK + 1) {
    throw new Error(`taker.tick must be 1..1000, got ${String(taker.tick)}`);
  }
  if (taker.amount <= 0n) {
    throw new Error("taker.amount must be positive");
  }
}

function normalizeBitmap(
  input: readonly (bigint | number)[],
): [
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
] {
  if (input.length !== 16) {
    throw new Error(`bitmap must have 16 words, got ${input.length}`);
  }
  return input.map((word) => BigInt(word)) as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
}

function findNextDown(
  bitmap: readonly bigint[],
  start: number,
): number {
  if (start <= MIN_TICK) return 0;
  const searchTick = Math.min(start - 1, MAX_TICK);
  let wordIndex = searchTick >> 6;
  let bitIndex = searchTick & 63;
  let word = bitmap[wordIndex] & maskLte(bitIndex);

  if (word !== 0n) return wordIndex * 64 + mostSignificantBit(word);

  for (wordIndex -= 1; wordIndex >= 0; wordIndex -= 1) {
    word = bitmap[wordIndex] ?? 0n;
    if (word !== 0n) {
      const tick = wordIndex * 64 + mostSignificantBit(word);
      if (tick >= MIN_TICK) return tick;
    }
  }
  return 0;
}

function maskLte(bitIndex: number): bigint {
  return bitIndex === 63 ? (1n << 64n) - 1n : (1n << BigInt(bitIndex + 1)) - 1n;
}

function mostSignificantBit(word: bigint): number {
  let bit = 0;
  while (word > 1n) {
    word >>= 1n;
    bit += 1;
  }
  return bit;
}
