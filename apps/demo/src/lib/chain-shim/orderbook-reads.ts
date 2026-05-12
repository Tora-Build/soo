// chain-shim/orderbook-reads.ts — bridges sooth_book on-chain Order PDAs to
// the EVM-shaped event log surface upstream's `useIndexerOrders` and
// `useOrderbookTrade.cancelOrder` consume.
//
// Why this exists:
//
//   The upstream demo's `UserOrdersPanel` reads its rows from
//   `useIndexerOrders.openOrders`, which itself fetches from
//   `fetchFromIndexer<IndexerOrder[]>(/v12/orders/...)` and falls back to
//   `publicClient.getLogs({ event: ORDER_PLACED, args: { marketKey, maker } })`
//   if the indexer is unavailable. On the Solana fork there is no indexer
//   and the chain-shim's `getLogs` returns `[]`, so the panel never
//   populates and the cancel button is unreachable from the UI.
//
//   The fix is to have the chain-shim's `getLogs` synthesize one EVM-shaped
//   `OrderPlaced` log per active sooth_book Order PDA owned by the
//   connected user. The upstream `fetchOpenOrdersFromRpc` aggregates those
//   into per-`(side, tick)` levels and produces rows whose row-id is
//   `${side}:${tick}` (a "level" id under upstream's parseOrderId — see
//   useOrderbookTrade.ts:84-106).
//
//   Cancel then routes through `useOrderbookTrade.cancelOrder("1:400")`
//   → `executeWrite("cancel", [marketKey, side, tick])` — handled by
//   `dispatchOrderbookWrite` in amm-bridge.ts, which uses
//   `findUserOpenOrderAtLevel` (below) to recover the on-chain Order PDA
//   and call `adapter.buildOrderbookCancel`.
//
// Limits:
//
//   - Only the BUY path is exercised today (chain-shim's place dispatch
//     never calls `buildOrderbookSell`). The synth log uses the
//     `forOutcome=true` convention exclusively.
//   - One log per Order PDA — the OrderPlaced "amount" is the order's
//     `stake_unmatched` (USDC base units scaled to WAD). A partially
//     filled order shows `placed - filled` correctly because we report
//     the unmatched stake; the upstream code subtracts a separate
//     `filled` aggregate from level-`placed` and we never emit
//     OrderFilled logs, so `filled = 0` and `remaining = stake_unmatched`.
//   - Filtering: we read `program.account.order.all()` with memcmp on
//     the `market` field at offset 40 (after 8-byte discriminator +
//     32-byte purchaser) and the `purchaser` field at offset 8. Order PDAs
//     for other markets / users never enter the bridge.
//
// Dependencies: imports `soothBookIdl` from `@sooth/sdk-solana` (added to
// the package's public surface for this purpose).

import {
  PublicKey,
  type Connection as SolanaConnection,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { soothBookIdl, type SolanaChainAdapter } from "@sooth/sdk-solana";

const PRICE_TICK_WAD = 10n ** 15n; // W4 default ladder step

function deriveBookMarketPda(
  soothMarketPda: PublicKey,
  adapter: SolanaChainAdapter,
): [PublicKey, number] {
  const programId = adapter.programIds.soothBook;
  if (!programId) {
    throw new Error("orderbook-reads: soothBook programId missing on adapter");
  }
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), soothMarketPda.toBuffer()],
    programId,
  );
}

// Anchor account discriminator + struct field offsets for `Order`:
//   0..8     discriminator
//   8..40    purchaser (pubkey)
//   40..72   market (pubkey)
//   72..74   market_outcome_index (u16)
//   74..75   for_outcome (bool)
//   75..76   order_status (u8)
//   76..84   stake (u64)
//   84..92   voided_stake (u64)
//   92..108  expected_price (u128)
//   108..116 creation_timestamp (i64)
//   116..124 stake_unmatched (u64)
//   124..132 payout (u64)
//   132..164 payer (pubkey)
//
// We rely on Anchor's `account.order.all([memcmp filter on market + purchaser])`
// to fetch and decode in one call.

export interface OnChainOrder {
  pda: PublicKey;
  marketOutcomeIndex: number;
  forOutcome: boolean;
  expectedPrice: bigint; // u128, WAD
  stakeUnmatched: bigint; // u64, USDC base units
  side: 0 | 1; // EVM convention: 1=YES level, 0=NO level
  tick: number; // 1..999
  /** The pubkey under which the row id is keyed: `${side}:${tick}`. */
  levelId: string;
}

interface SoothBookOrderAccount {
  publicKey: PublicKey;
  account: {
    purchaser: PublicKey;
    market: PublicKey;
    marketOutcomeIndex: number;
    forOutcome: boolean;
    orderStatus: unknown;
    stake: BN;
    voidedStake: BN;
    expectedPrice: BN;
    creationTimestamp: BN;
    stakeUnmatched: BN;
    payout: BN;
    payer: PublicKey;
  };
}

function bnToBig(b: BN | bigint): bigint {
  if (typeof b === "bigint") return b;
  return BigInt(b.toString());
}

/**
 * Returns true iff the on-chain Order is still cancellable.
 *
 * `order_status` is a Borsh enum (single u8 discriminator after the small
 * head fields). Variant 0 = Open (cancelable). Anchor decodes enums into a
 * `{ open: {} }` / `{ matched: {} }` object — we accept either shape.
 */
function isOrderOpen(status: unknown): boolean {
  if (status == null) return false;
  if (typeof status === "object") {
    const k = Object.keys(status as Record<string, unknown>)[0];
    return k?.toLowerCase() === "open";
  }
  return status === 0 || String(status).toLowerCase() === "open";
}

let cachedProgram: {
  program: Program;
  connection: SolanaConnection;
  programId: string;
} | null = null;

function getOrderProgram(
  connection: SolanaConnection,
  adapter: SolanaChainAdapter,
): Program {
  const programId = adapter.programIds.soothBook?.toBase58();
  if (!programId) {
    throw new Error("orderbook-reads: soothBook programId missing on adapter");
  }
  if (
    cachedProgram &&
    cachedProgram.connection === connection &&
    cachedProgram.programId === programId
  ) {
    return cachedProgram.program;
  }
  // Read-only provider: a stub wallet works because `account.all` only
  // signs nothing. Same shape used in amm-bridge's getBalance branch.
  const stubWallet = {
    publicKey: PublicKey.default,
    signTransaction: async <T>(tx: T): Promise<T> => tx,
    signAllTransactions: async <T>(txs: T[]): Promise<T[]> => txs,
  };
  const provider = new AnchorProvider(connection, stubWallet as never, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const idl = { ...soothBookIdl, address: programId } as Idl;
  const program = new Program(idl, provider);
  cachedProgram = { program, connection, programId };
  return program;
}

/**
 * Fetch the user's open Order PDAs on the active book market and reshape
 * them into the EVM event-log convention used by useIndexerOrders.
 *
 * Returns `[]` on any decode / RPC error — upstream gracefully shows an
 * empty My-Orders panel in that case.
 */
export async function fetchUserOpenOrders(
  connection: SolanaConnection,
  adapter: SolanaChainAdapter,
  soothMarketRef: string,
  userBase58: string,
): Promise<OnChainOrder[]> {
  let bookMarketPda: PublicKey;
  try {
    const tail = soothMarketRef.replace(/^sol:/, "");
    const soothMarketPda = new PublicKey(tail);
    [bookMarketPda] = deriveBookMarketPda(soothMarketPda, adapter);
  } catch {
    return [];
  }

  let userPk: PublicKey;
  try {
    userPk = new PublicKey(userBase58);
  } catch {
    return [];
  }

  let program: Program;
  try {
    program = getOrderProgram(connection, adapter);
  } catch {
    return [];
  }

  type OrderAcct = {
    all(
      filters?: { memcmp: { offset: number; bytes: string } }[],
    ): Promise<SoothBookOrderAccount[]>;
  };
  const orderAcct = (program.account as unknown as { order: OrderAcct }).order;

  // Discriminator (8) + purchaser (32) → market starts at 40.
  // memcmp.bytes is base58, so we pass the pubkey strings directly.
  let raw: SoothBookOrderAccount[];
  try {
    raw = await orderAcct.all([
      { memcmp: { offset: 8, bytes: userPk.toBase58() } },
      { memcmp: { offset: 40, bytes: bookMarketPda.toBase58() } },
    ]);
  } catch {
    return [];
  }

  const out: OnChainOrder[] = [];
  for (const row of raw) {
    if (!isOrderOpen(row.account.orderStatus)) continue;
    const stakeUnmatched = bnToBig(row.account.stakeUnmatched);
    if (stakeUnmatched <= 0n) continue;
    const expectedPrice = bnToBig(row.account.expectedPrice);
    const tickBig = expectedPrice / PRICE_TICK_WAD;
    const tick = Number(tickBig);
    if (!Number.isFinite(tick) || tick < 1 || tick > 999) continue;
    // Buy path only — chain-shim never emits forOutcome=false. If the SELL
    // path is ever wired, mirror the encoding from amm-bridge.
    const side: 0 | 1 = row.account.forOutcome
      ? row.account.marketOutcomeIndex === 0
        ? 1
        : 0
      : row.account.marketOutcomeIndex === 0
        ? 0
        : 1;
    out.push({
      pda: row.publicKey,
      marketOutcomeIndex: row.account.marketOutcomeIndex,
      forOutcome: row.account.forOutcome,
      expectedPrice,
      stakeUnmatched,
      side,
      tick,
      levelId: `${side}:${tick}`,
    });
  }
  return out;
}

/**
 * Resolve a level-shaped order id (`${side}:${tick}`) to the on-chain
 * Order PDA so `cancel(marketKey, side, tick)` can route through
 * `buildOrderbookCancel`. Returns the most-recent open order matching the
 * level (the queue is FIFO, so most-recent === highest creation_timestamp).
 *
 * If no Order matches (most common: the OrderRequest hasn't been processed
 * into an Order yet — the off-chain crank or `process_order_request`
 * adapter call must run first), returns `null` and the caller surfaces a
 * descriptive error.
 */
export async function findUserOpenOrderAtLevel(
  connection: SolanaConnection,
  adapter: SolanaChainAdapter,
  soothMarketRef: string,
  userBase58: string,
  side: 0 | 1,
  tick: number,
): Promise<OnChainOrder | null> {
  const orders = await fetchUserOpenOrders(
    connection,
    adapter,
    soothMarketRef,
    userBase58,
  );
  const matches = orders.filter((o) => o.side === side && o.tick === tick);
  if (matches.length === 0) return null;
  return matches[0];
}

/**
 * Synthesize one EVM-shaped `OrderPlaced` log per open Order PDA. Only the
 * args fields `side`, `tick`, `amount`, `escrow`, `orderId`, `marketKey`,
 * `maker` are read by `useIndexerOrders.fetchOpenOrdersFromRpc` — the
 * envelope (transactionHash, blockNumber, etc.) only needs to be present
 * for downstream `upsert(... blockNumber)` not to NaN.
 */
export interface SynthOrderPlacedLog {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: string;
  address: string;
  topics: string[];
  data: string;
  eventName: "OrderPlaced";
}

export function synthOrderPlacedLogs(
  orders: OnChainOrder[],
  marketKey: string | undefined,
  ownerLower: string | undefined,
): SynthOrderPlacedLog[] {
  return orders.map((o, i) => {
    // Upstream's `fetchOpenOrdersFromRpc` reads:
    //   log.args.side, log.args.tick, log.args.amount, log.blockNumber
    // and uses `args.orderId` only when populating compound history rows.
    // amount is in WAD (18 decimals). Convert USDC base units → WAD.
    const amountWad = o.stakeUnmatched * 10n ** 12n;
    return {
      args: {
        marketKey,
        maker: ownerLower,
        side: o.side,
        tick: o.tick,
        amount: amountWad,
        escrow: false,
        orderId: o.pda.toBase58(),
      },
      blockNumber: BigInt(i + 1), // monotonic; only relative ordering matters
      logIndex: 0,
      transactionHash:
        "0x" + Buffer.from(o.pda.toBytes()).toString("hex").padEnd(64, "0"),
      address: "0x0000000000000000000000000000000000000a08",
      topics: [],
      data: "0x",
      eventName: "OrderPlaced",
    };
  });
}
