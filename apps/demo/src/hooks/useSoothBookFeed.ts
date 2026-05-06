import { useCallback, useState } from "react";
import toast from "react-hot-toast";
import { parseAbiItem } from "@/lib/chain-shim";
import { usePublicClient } from "@/lib/chain-shim";
import { INDEXER_CHAIN_START_BLOCKS, fetchFromIndexer } from "./indexer/config";

const DEFAULT_LOOKBACK_BLOCKS = 10_000n;
const USER_SCAN_CHUNK_SIZE = 400_000n;

// Chains that enforce strict eth_getLogs block-range caps. On these chains we
// MUST chunk both the anonymous feed (DEFAULT_LOOKBACK_BLOCKS) and the
// per-user backfill (USER_SCAN_CHUNK_SIZE), otherwise the RPC returns HTTP
// 400 and viem throws — surfaced to the user as "Failed to load activity"
// even when the underlying tx (place/cancel) succeeded.
const STRICT_GETLOGS_CHUNK: Record<number, bigint> = {
  6343: 9_999n, // MegaETH: 10k block cap
  998: 999n, // HyperEVM: 1k block cap
  10143: 500n, // Monad public RPC: strict cap
};

const CHAIN_START_BLOCKS: Record<number, bigint> = Object.fromEntries(
  Object.entries(INDEXER_CHAIN_START_BLOCKS).map(([chainId, startBlock]) => [
    Number(chainId),
    BigInt(startBlock),
  ]),
) as Record<number, bigint>;

const ORDER_PLACED = parseAbiItem(
  "event OrderPlaced(bytes32 indexed marketKey, uint8 side, uint16 tick, address indexed maker, uint128 amount, bool escrow, uint64 orderId)",
);
const ORDER_FILLED = parseAbiItem(
  "event OrderFilled(bytes32 indexed marketKey, uint8 takerSide, uint16 yesTick, uint16 noTick, address indexed taker, address indexed maker, uint128 amount, uint256 surplus, uint64 makerOrderId)",
);
const ORDER_CANCELLED = parseAbiItem(
  "event OrderCancelled(bytes32 indexed marketKey, uint8 side, uint16 tick, address indexed maker, uint128 amount, uint64 orderId)",
);

export type FeedItem = {
  id: string;
  type: "placed" | "filled" | "cancelled";
  side: "YES" | "NO";
  tick: string;
  amount: bigint;
  who: `0x${string}`;
  block: bigint;
  logIndex: number;
  escrow?: boolean;
  surplus?: bigint;
  maker?: `0x${string}`;
  makerSide?: "YES" | "NO";
  makerTick?: string;
  orderId?: string;
  makerOrderId?: string;
};

type UseSoothBookFeedOptions = {
  owner?: `0x${string}`;
};

function getScanRanges(
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint,
): Array<{ from: bigint; to: bigint }> {
  if (toBlock < fromBlock) return [];

  const ranges: Array<{ from: bigint; to: bigint }> = [];
  let start = fromBlock;

  while (start <= toBlock) {
    const end = start + chunkSize - 1n;
    ranges.push({ from: start, to: end > toBlock ? toBlock : end });
    start = end + 1n;
  }

  return ranges;
}

// Indexer endpoint shapes. Mirrors the market app; see
// apps/market/src/hooks/useIndexerOrders.ts for the canonical definitions.
type IndexerOrder = {
  orderId: string;
  side: number;
  tick: number;
  maker: string;
  amount: string;
  escrow: boolean;
  status: string;
  filledAmount: string;
  blockNumber: string;
  txHash: string;
};

type IndexerActivity = {
  type: "fill" | "order" | "mint_merge";
  timestamp: string;
  data: {
    id?: string;
    side?: number;
    tick?: number;
    maker?: string;
    amount?: string;
    escrow?: boolean;
    orderId?: string;
    takerSide?: number;
    yesTick?: number;
    noTick?: number;
    taker?: string;
    surplus?: string;
    blockNumber?: string;
    txHash?: string;
  };
};

/**
 * Fetch the user-scoped (or anonymous) feed from the Ponder indexer and
 * project it into FeedItem[]. Returns null if the indexer is unreachable or
 * refuses the request — callers should fall back to RPC getLogs scanning.
 *
 * Why this exists: the legacy getLogs path reconstructs feed state from raw
 * chain events, which on strict-cap chains (MegaETH/HyperEVM/Monad) forces
 * us to scan either too narrow a window (missing old orders) or fire
 * thousands of chunked requests (unusable). The indexer has the full state.
 */
async function fetchFromIndexerFeed(
  chainId: number,
  marketKey: string,
  owner: string | undefined,
): Promise<FeedItem[] | null> {
  // /v12/orders is the authoritative source for open-order reconstruction
  // because it includes orderId per row. /v12/activity's fill entries don't
  // carry makerOrderId (the indexer's OrderFilled handler never persists it
  // — see packages/indexer/src/soothbook.ts), which breaks the per-order
  // fill subtraction in buildOpenOrders and inflates the "open" count.
  //
  // IMPORTANT: `/v12/orders/:chainId/:marketKey` (no owner) hard-filters
  // `status='active'` server-side. To get cancelled + filled orders for the
  // history view we must use the owner-scoped `/v12/orders/:chainId/
  // :marketKey/:owner?status=all` variant. Without this we'd miss every
  // closed order and the UserOrdersPanel history stays empty.
  //
  // Strategy:
  //   1. Synthesize `placed` + `filled` + `cancelled` FeedItems from orders.
  //      Every event is keyed by the SAME orderId so buildOpenOrders's
  //      subtraction lands cleanly.
  //   2. Don't layer real fills from /v12/activity — see comment below.
  const orders = owner
    ? await fetchFromIndexer<IndexerOrder[]>(
        `/v12/orders/${chainId}/${marketKey}/${owner.toLowerCase()}?status=all`,
      )
    : await fetchFromIndexer<IndexerOrder[]>(
        `/v12/orders/${chainId}/${marketKey}`,
      );
  if (orders === null) return null;

  const makerParam = owner
    ? `?maker=${owner.toLowerCase()}&limit=500`
    : `?limit=500`;
  const activity = await fetchFromIndexer<IndexerActivity[]>(
    `/v12/activity/${chainId}/${marketKey}${makerParam}`,
  );

  const items: FeedItem[] = [];

  // 1. Per-order synthesis — placed/filled/cancelled all keyed by orderId
  for (const order of orders) {
    const sideLabel: "YES" | "NO" = Number(order.side) === 1 ? "YES" : "NO";
    const tickStr = String(order.tick);
    const orderIdStr = String(order.orderId);
    const placedAmount = BigInt(order.amount);
    const filledAmount = BigInt(order.filledAmount ?? "0");
    const placedBlock = BigInt(order.blockNumber);
    const maker = order.maker as `0x${string}`;

    items.push({
      id: `${order.txHash}-${orderIdStr}-p`,
      type: "placed",
      side: sideLabel,
      tick: tickStr,
      amount: placedAmount,
      who: maker,
      block: placedBlock,
      logIndex: 0,
      escrow: Boolean(order.escrow),
      orderId: orderIdStr,
    });

    if (filledAmount > 0n) {
      // Synthetic maker-side fill entry. Collapses multiple real fills into
      // one aggregate — history display loses per-fill granularity, but
      // open-order reconstruction works because makerOrderId matches the
      // placed event's orderId.
      items.push({
        id: `${order.txHash}-${orderIdStr}-f`,
        type: "filled",
        side: sideLabel === "YES" ? "NO" : "YES", // taker side (opposite)
        tick: tickStr,
        amount: filledAmount,
        who: maker, // synthetic — taker address unknown, use maker
        block: placedBlock,
        logIndex: 1,
        maker,
        makerSide: sideLabel,
        makerTick: tickStr,
        makerOrderId: orderIdStr,
      });
    }

    if (order.status === "cancelled") {
      const remaining = placedAmount - filledAmount;
      if (remaining > 0n) {
        items.push({
          id: `${order.txHash}-${orderIdStr}-c`,
          type: "cancelled",
          side: sideLabel,
          tick: tickStr,
          amount: remaining,
          who: maker,
          block: placedBlock,
          logIndex: 2,
          orderId: orderIdStr,
        });
      }
    }
  }

  // /v12/activity is currently unused for feed synthesis. Adding real fills
  // here on top of the synthetic per-order fills above would double-count in
  // buildHistoryRows, because the indexer's OrderFilled handler doesn't
  // persist makerOrderId so we can't reliably link a real fill back to its
  // placed order without an ambiguous (maker, side, tick) join. The tradeoff:
  // history shows 1 aggregate fill entry per order instead of per-match
  // detail, in exchange for correct open-order counts.
  void activity;

  items.sort((a, b) => {
    if (a.block === b.block) return b.logIndex - a.logIndex;
    return a.block > b.block ? -1 : 1;
  });
  return items;
}

export function useSoothBookFeed(
  soothBookAddress: `0x${string}` | undefined,
  marketKey: `0x${string}` | undefined,
  options?: UseSoothBookFeedOptions,
) {
  const publicClient = usePublicClient();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const owner = options?.owner;

  const refresh = useCallback(async () => {
    if (!publicClient || !soothBookAddress || !marketKey) return;
    setIsLoading(true);
    try {
      // Preferred path: fetch from indexer. It has full order history so the
      // user sees every open order regardless of how old, and the response
      // is one round trip instead of thousands of chunked getLogs calls on
      // strict-cap chains (MegaETH/HyperEVM/Monad).
      const chainIdEarly = publicClient.chain?.id;
      if (chainIdEarly) {
        const indexerItems = await fetchFromIndexerFeed(
          chainIdEarly,
          marketKey,
          owner,
        );
        if (indexerItems !== null) {
          setFeed(indexerItems);
          setIsLoading(false);
          return;
        }
      }

      const latest = await publicClient.getBlockNumber();

      let placed: Awaited<
        ReturnType<typeof publicClient.getLogs<typeof ORDER_PLACED>>
      > = [];
      let filled: Awaited<
        ReturnType<typeof publicClient.getLogs<typeof ORDER_FILLED>>
      > = [];
      let cancelled: Awaited<
        ReturnType<typeof publicClient.getLogs<typeof ORDER_CANCELLED>>
      > = [];

      const chainId = publicClient.chain?.id;
      const strictChunk = STRICT_GETLOGS_CHUNK[chainId ?? 0];

      const ownerLower = owner?.toLowerCase() as `0x${string}` | undefined;
      if (!ownerLower) {
        const from =
          latest > DEFAULT_LOOKBACK_BLOCKS
            ? latest - DEFAULT_LOOKBACK_BLOCKS
            : 0n;
        // On strict-cap chains the single `from → latest` range is rejected.
        // Chunk it into pieces that fit the cap.
        const ranges = strictChunk
          ? getScanRanges(from, latest, strictChunk)
          : [{ from, to: latest }];

        for (const range of ranges) {
          const [chunkPlaced, chunkFilled, chunkCancelled] = await Promise.all([
            publicClient.getLogs({
              address: soothBookAddress,
              event: ORDER_PLACED,
              args: { marketKey },
              fromBlock: range.from,
              toBlock: range.to,
            }),
            publicClient.getLogs({
              address: soothBookAddress,
              event: ORDER_FILLED,
              args: { marketKey },
              fromBlock: range.from,
              toBlock: range.to,
            }),
            publicClient.getLogs({
              address: soothBookAddress,
              event: ORDER_CANCELLED,
              args: { marketKey },
              fromBlock: range.from,
              toBlock: range.to,
            }),
          ]);
          placed.push(...chunkPlaced);
          filled.push(...chunkFilled);
          cancelled.push(...chunkCancelled);
        }
      } else {
        const fallbackStart = latest > 2_000_000n ? latest - 2_000_000n : 0n;
        const startBlock = CHAIN_START_BLOCKS[chainId ?? 0] ?? fallbackStart;
        // For the per-user backfill, bound the start block tightly on strict
        // chains so we don't fan out thousands of 10k-block chunks across
        // months of history.
        const boundedStart = strictChunk
          ? latest > DEFAULT_LOOKBACK_BLOCKS * 10n
            ? latest - DEFAULT_LOOKBACK_BLOCKS * 10n
            : startBlock
          : startBlock;
        const chunkSize = strictChunk ?? USER_SCAN_CHUNK_SIZE;
        const ranges = getScanRanges(boundedStart, latest, chunkSize);

        for (const range of ranges) {
          const [
            chunkPlaced,
            chunkFilledAsTaker,
            chunkFilledAsMaker,
            chunkCancelled,
          ] = await Promise.all([
            publicClient.getLogs({
              address: soothBookAddress,
              event: ORDER_PLACED,
              args: { marketKey, maker: ownerLower },
              fromBlock: range.from,
              toBlock: range.to,
            }),
            publicClient.getLogs({
              address: soothBookAddress,
              event: ORDER_FILLED,
              args: { marketKey, taker: ownerLower },
              fromBlock: range.from,
              toBlock: range.to,
            }),
            publicClient.getLogs({
              address: soothBookAddress,
              event: ORDER_FILLED,
              args: { marketKey, maker: ownerLower },
              fromBlock: range.from,
              toBlock: range.to,
            }),
            publicClient.getLogs({
              address: soothBookAddress,
              event: ORDER_CANCELLED,
              args: { marketKey, maker: ownerLower },
              fromBlock: range.from,
              toBlock: range.to,
            }),
          ]);

          placed.push(...chunkPlaced);
          filled.push(...chunkFilledAsTaker, ...chunkFilledAsMaker);
          cancelled.push(...chunkCancelled);
        }
      }

      const items: FeedItem[] = [];

      for (const log of placed) {
        const side = Number(log.args.side) === 1 ? "YES" : "NO";
        items.push({
          id: `${log.transactionHash}-${log.logIndex}-p`,
          type: "placed",
          side,
          tick: String(log.args.tick),
          amount: log.args.amount ?? 0n,
          who: log.args.maker as `0x${string}`,
          block: log.blockNumber ?? 0n,
          logIndex: Number(log.logIndex),
          escrow: Boolean(log.args.escrow),
          orderId: String(log.args.orderId ?? ""),
        });
      }

      for (const log of filled) {
        const takerSide = Number(log.args.takerSide);
        const side = takerSide === 1 ? "YES" : "NO";
        const makerSide = takerSide === 1 ? "NO" : "YES";
        const makerTick =
          takerSide === 1 ? String(log.args.noTick) : String(log.args.yesTick);
        items.push({
          id: `${log.transactionHash}-${log.logIndex}-f`,
          type: "filled",
          side,
          tick: `${log.args.yesTick}/${log.args.noTick}`,
          amount: log.args.amount ?? 0n,
          surplus: log.args.surplus ?? 0n,
          who: log.args.taker as `0x${string}`,
          block: log.blockNumber ?? 0n,
          logIndex: Number(log.logIndex),
          maker: log.args.maker as `0x${string}`,
          makerSide,
          makerTick,
          makerOrderId: String(log.args.makerOrderId ?? ""),
        });
      }

      for (const log of cancelled) {
        const side = Number(log.args.side) === 1 ? "YES" : "NO";
        items.push({
          id: `${log.transactionHash}-${log.logIndex}-c`,
          type: "cancelled",
          side,
          tick: String(log.args.tick),
          amount: log.args.amount ?? 0n,
          who: log.args.maker as `0x${string}`,
          block: log.blockNumber ?? 0n,
          logIndex: Number(log.logIndex),
          orderId: String(log.args.orderId ?? ""),
        });
      }

      const deduped = new Map<string, FeedItem>();
      for (const item of items) {
        const baseType = item.type;
        const key = `${item.block.toString()}-${item.logIndex}-${baseType}`;
        if (deduped.has(key)) continue;
        deduped.set(key, item);
      }

      const finalItems = Array.from(deduped.values());
      finalItems.sort((a, b) => {
        if (a.block === b.block) return b.logIndex - a.logIndex;
        return a.block > b.block ? -1 : 1;
      });
      setFeed(finalItems);
    } catch {
      toast.error("Failed to load activity");
    } finally {
      setIsLoading(false);
    }
  }, [publicClient, soothBookAddress, marketKey, owner]);

  return { feed, isLoading, refresh };
}
