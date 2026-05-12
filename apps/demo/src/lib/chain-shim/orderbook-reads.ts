// chain-shim/orderbook-reads.ts — bridges W7 BookSide inline orders to the
// EVM-shaped event log surface upstream's useIndexerOrders consumes.

import { PublicKey, type Connection as SolanaConnection } from "@solana/web3.js";
import { type SolanaChainAdapter } from "@sooth/sdk-solana";

export interface OnChainOrder {
  orderId: bigint;
  maker: PublicKey;
  amount: bigint; // WAD shares
  side: 0 | 1;
  tick: number;
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

  const marketBook = await adapter.fetchMarketBook(soothMarketRef);
  if (!marketBook) return [];

  const out: OnChainOrder[] = [];
  for (const side of [0, 1] as const) {
    const ticks = ticksFromBitmap(
      side === 1 ? marketBook.bitmapFor : marketBook.bitmapAgainst,
    );
    for (const tick of ticks) {
      const bookSide = await adapter.fetchBookSide(soothMarketRef, side, tick);
      if (!bookSide) continue;
      const start = Math.max(0, Math.floor(bookSide.headIndex));
      for (let index = start; index < bookSide.orders.length; index += 1) {
        const order = bookSide.orders[index];
        if (!order || order.amount <= 0n || !order.maker.equals(userPk)) {
          continue;
        }
        out.push({
          orderId: order.id,
          maker: order.maker,
          amount: order.amount,
          side,
          tick,
          levelId: `${side}:${tick}`,
        });
      }
    }
  }

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
        escrow: false,
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
