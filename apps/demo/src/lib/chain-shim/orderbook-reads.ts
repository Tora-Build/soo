// A trader's resting orders, in the EVM-shaped form upstream components expect.
//
// The book is a single account, so this is one read. `escrow` is always
// false: collateral is posted in USDC per leg, never by delivering outcome
// tokens, so the flag distinguishes nothing here — it exists only to satisfy
// the shape `ActiveOrdersCard` and `wagmi-shim` consume.

import { PublicKey, type Connection as SolanaConnection } from "@solana/web3.js";
import { bookPda, type SolanaChainAdapter } from "@sooth/sdk-solana";

export interface OnChainOrder {
  orderId: bigint;
  maker: PublicKey;
  amount: bigint; // WAD shares
  side: 0 | 1;
  tick: number;
  escrow: boolean;
  levelId: string;
}

export async function fetchUserOpenOrders(
  _connection: SolanaConnection,
  adapter: SolanaChainAdapter,
  soothMarketRef: string,
  userBase58: string,
): Promise<OnChainOrder[]> {
  let userPk: PublicKey;
  try {
    userPk = new PublicKey(userBase58);
  } catch {
    return [];
  }

  let snapshot;
  try {
    snapshot = await adapter.readBook(soothMarketRef);
  } catch {
    // No book on this market yet. Empty, not an error.
    return [];
  }

  const out: OnChainOrder[] = [];
  for (const order of [...snapshot.bids, ...snapshot.asks]) {
    if (order.trader !== userBase58) continue;
    out.push({
      orderId: order.seq,
      maker: userPk,
      // Callers format this as WAD; the book counts in USDC base units (1e6).
      amount: order.amount * 1_000_000_000_000n,
      side: (order.side === 0 ? 1 : 0) as 0 | 1,
      tick: order.priceTick,
      escrow: false,
      levelId: `${order.side}:${order.priceTick}`,
    });
  }
  // Newest first, matching the previous ordering.
  return out.sort((a, b) => (a.orderId > b.orderId ? -1 : 1));
}

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
  return orders.find((o) => o.side === side && o.tick === tick) ?? null;
}

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
    const orderId = o.orderId.toString();
    return {
      args: {
        marketKey,
        maker: ownerLower,
        side: o.side,
        tick: o.tick,
        amount: o.amount,
        escrow: o.escrow,
        orderId,
      },
      blockNumber: BigInt(i + 1),
      logIndex: 0,
      transactionHash: "0x" + o.orderId.toString(16).padStart(64, "0").slice(-64),
      address: "0x0000000000000000000000000000000000000a08",
      topics: [],
      data: "0x",
      eventName: "OrderPlaced",
    };
  });
}

function ticksFromBitmap(input: readonly (bigint | number)[]): number[] {
  const ticks: number[] = [];
  for (let wordIndex = 0; wordIndex < input.length; wordIndex += 1) {
    let word = BigInt(input[wordIndex] ?? 0);
    while (word !== 0n) {
      const bit = leastSignificantBit(word);
      const tick = wordIndex * 64 + bit;
      if (tick >= 1 && tick <= 999) ticks.push(tick);
      word &= word - 1n;
    }
  }
  return ticks.sort((a, b) => b - a);
}

function leastSignificantBit(word: bigint): number {
  let bit = 0;
  let value = word;
  while ((value & 1n) === 0n) {
    value >>= 1n;
    bit += 1;
  }
  return bit;
}


/**
 * A wallet's open orders across MANY markets, in three RPC phases instead of
 * a read-everything sweep.
 *
 * The naive version called `readBook` per market — a market fetch plus a
 * book-account fetch each, against accounts that run to tens of kilobytes —
 * thirty-two times to find the two or three books that exist. Thirty seconds
 * on a rate-limited gateway. The shape of the data allows better:
 *
 *   1. one getMultipleAccountsInfo over every market, sliced to the 16-byte
 *      market_id (offset 8) — the only field book derivation needs;
 *   2. one getMultipleAccountsInfo over the derived book PDAs, sliced to
 *      zero bytes — existence is the question, not content;
 *   3. full `readBook` only on the books that exist, which is the number of
 *      GRADUATED markets, not the number of markets.
 */
export async function fetchUserOpenOrdersAcrossMarkets(
  connection: SolanaConnection,
  adapter: SolanaChainAdapter,
  marketRefs: string[],
  userBase58: string,
): Promise<Array<{ marketRef: string; order: OnChainOrder }>> {
  if (marketRefs.length === 0) return [];
  const marketPks = marketRefs.map(
    (r) => new PublicKey(r.replace(/^(sol:|0x)/, "")),
  );
  let marketInfos: Array<{ data: Uint8Array } | null>;
  try {
    marketInfos = (await connection.getMultipleAccountsInfo(marketPks, {
      dataSlice: { offset: 8, length: 16 },
    } as never)) as never;
  } catch {
    return [];
  }
  const withBooks: Array<{ ref: string; bookPk: PublicKey }> = [];
  marketInfos.forEach((info, i) => {
    if (!info || info.data.length < 16) return;
    const [pk] = bookPda(new Uint8Array(info.data), adapter.programIds);
    withBooks.push({ ref: marketRefs[i]!, bookPk: pk });
  });
  if (withBooks.length === 0) return [];
  let bookInfos: Array<unknown | null>;
  try {
    bookInfos = await connection.getMultipleAccountsInfo(
      withBooks.map((b) => b.bookPk),
      { dataSlice: { offset: 0, length: 0 } } as never,
    );
  } catch {
    return [];
  }
  const existing = withBooks.filter((_, i) => bookInfos[i] != null);
  const out: Array<{ marketRef: string; order: OnChainOrder }> = [];
  await Promise.all(
    existing.map(async ({ ref }) => {
      try {
        const orders = await fetchUserOpenOrders(connection, adapter, ref, userBase58);
        for (const order of orders) out.push({ marketRef: ref, order });
      } catch {
        // One unreadable book costs its own market only.
      }
    }),
  );
  return out;
}
