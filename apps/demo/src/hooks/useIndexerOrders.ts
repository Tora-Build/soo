import { useQuery } from "@tanstack/react-query";
import {
  clampUnit,
  refundAmountWad as computeRefundWad,
  tickToYesPrice,
} from "../lib/orderbook-math";
import { formatUnits, parseAbiItem, type Address } from "@/lib/chain-shim";
import { usePublicClient } from "@/lib/chain-shim";
import { fetchFromIndexer } from "./indexer/config";
import { shortenAddress as truncateAddress } from "../utils/format";
import { useChainStore } from "../store/useChainStore";
import { useOrderStore } from "../store/useOrderStore";

/** Raw order from /v12/orders endpoint */
type IndexerOrder = {
  id: string;
  // SoothBook-emitted on-chain order id (uint64). String-encoded so JS
  // doesn't lose precision. Used by the cancel handler — see
  // orderToOpen() below for why this matters.
  orderId: string;
  chainId: number;
  marketKey: string;
  side: number; // 0=NO, 1=YES
  tick: number;
  maker: string;
  amount: string; // WAD
  escrow: boolean;
  status: string; // 'active' | 'cancelled' | 'filled'
  filledAmount: string; // WAD
  createdAt: string;
  blockNumber: string;
  txHash: string;
};

/** Raw activity from /v12/activity endpoint */
type IndexerActivity = {
  type: "fill" | "order" | "mint_merge";
  timestamp: string;
  data: {
    id: string;
    chainId: number;
    marketKey: string;
    // fill fields
    takerSide?: number;
    yesTick?: number;
    noTick?: number;
    taker?: string;
    maker?: string;
    amount?: string;
    surplus?: string;
    // order fields
    side?: number;
    tick?: number;
    escrow?: boolean;
    status?: string;
    filledAmount?: string;
    createdAt?: string;
    blockNumber?: string;
    txHash?: string;
    // mint_merge fields
    user?: string;
    action?: string;
    timestamp?: string;
  };
};

const ORDER_PLACED = parseAbiItem(
  "event OrderPlaced(bytes32 indexed marketKey, uint8 side, uint16 tick, address indexed maker, uint128 amount, bool escrow, uint64 orderId)",
);
const ORDER_CANCELLED = parseAbiItem(
  "event OrderCancelled(bytes32 indexed marketKey, uint8 side, uint16 tick, address indexed maker, uint128 amount, uint64 orderId)",
);
const ORDER_FILLED = parseAbiItem(
  "event OrderFilled(bytes32 indexed marketKey, uint8 takerSide, uint16 yesTick, uint16 noTick, address indexed taker, address indexed maker, uint128 amount, uint256 surplus, uint64 makerOrderId)",
);

const CHAIN_LOOKBACK_BLOCKS: Record<number, bigint> = {
  84532: 200_000n,
  10143: 20_000n,
  37111: 50_000n,
};
const CHAIN_CHUNK_SIZES: Record<number, bigint> = {
  84532: 5_000n,
  10143: 500n,
  37111: 2_000n,
};

type PublicClient = NonNullable<ReturnType<typeof usePublicClient>>;

function toHexAddress(value: string): `0x${string}` {
  return value.toLowerCase() as `0x${string}`;
}

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

function getFallbackWindow(
  chainId: number | undefined,
  latest: bigint,
): { fromBlock: bigint; chunkSize: bigint } {
  const lookback = CHAIN_LOOKBACK_BLOCKS[chainId ?? 0] ?? 100_000n;
  const chunkSize = CHAIN_CHUNK_SIZES[chainId ?? 0] ?? 2_000n;
  const fromBlock = latest > lookback ? latest - lookback : 0n;
  return { fromBlock, chunkSize };
}

export type OpenOrder = {
  id: string;
  outcome: 0 | 1;
  yesPrice: number;
  amount: number;
  fillPct: number;
  timestamp: number;
  isBuy: boolean;
  marketAddress: `0x${string}`;
  marketName: string;
};

export type HistoryRow = {
  key: string;
  type: "placed" | "filled" | "cancelled";
  side: "YES" | "NO";
  orderId: string;
  orderRef: string;
  amount: number;
  yesPrice: number;
  refundAmountWad: bigint | null;
  timestamp: number;
  sortKey: number;
};

function clampPercent(v: number): number {
  return Math.max(0, Math.min(100, v));
}

function orderToOpen(
  order: IndexerOrder,
  marketAddress: `0x${string}`,
): OpenOrder {
  const preFill =
    useOrderStore.getState().preFillAmounts[order.orderId] ?? 0;
  const initial = Number(formatUnits(BigInt(order.amount), 18));
  const filled = Number(formatUnits(BigInt(order.filledAmount), 18));
  const remaining = Math.max(0, initial - filled);
  const originalAmount = initial + preFill;
  const fillPct =
    originalAmount > 0 ? ((originalAmount - remaining) / originalAmount) * 100 : 0;
  const yesPrice =
    order.side === 1
      ? tickToYesPrice(order.tick, 1)
      : tickToYesPrice(order.tick, 0);

  // `id` is what gets passed to onCancelOrder, which feeds parseOrderId.
  // Use the on-chain `orderId` (pure-digit string) so parseOrderId returns
  // {kind:"id"} and cancel hits cancelById on the exact order. The
  // indexer's compound `${txhash}-${logIdx}` shape parsed as a tick and
  // silently cancelled the wrong level.
  return {
    id: order.orderId,
    outcome: order.side as 0 | 1,
    yesPrice,
    amount: remaining,
    fillPct: clampPercent(fillPct),
    timestamp: Number(order.blockNumber),
    isBuy: true,
    marketAddress,
    marketName: truncateAddress(marketAddress),
  };
}

function activityToHistory(act: IndexerActivity): HistoryRow | null {
  const d = act.data;
  if (act.type === "mint_merge") return null;

  if (act.type === "order") {
    const side: "YES" | "NO" = d.side === 1 ? "YES" : "NO";
    const yesPrice =
      d.side === 1
        ? tickToYesPrice(d.tick ?? 0, 1)
        : tickToYesPrice(d.tick ?? 0, 0);
    const status = d.status ?? "active";
    const type =
      status === "cancelled" ? ("cancelled" as const) : ("placed" as const);

    let refundAmountWad: bigint | null = null;
    if (status === "cancelled" && !d.escrow && d.tick != null) {
      const tick = BigInt(d.tick);
      const amt = BigInt(d.amount ?? "0");
      refundAmountWad = computeRefundWad(tick, amt);
    }

    return {
      key: d.id,
      type,
      side,
      orderId: d.id,
      orderRef: d.txHash ?? d.id,
      amount: Number(formatUnits(BigInt(d.amount ?? "0"), 18)),
      yesPrice,
      refundAmountWad,
      timestamp: Number(d.blockNumber ?? "0"),
      sortKey: Number(d.blockNumber ?? "0") * 10_000,
    };
  }

  if (act.type === "fill") {
    const takerSide = d.takerSide ?? 0;
    const side: "YES" | "NO" = takerSide === 1 ? "YES" : "NO";
    const yesTick = d.yesTick ?? 0;
    const yesPrice = clampUnit(yesTick / 1000);
    const surplus = d.surplus ? BigInt(d.surplus) : null;

    return {
      key: d.id,
      type: "filled",
      side,
      orderId: "",
      orderRef: d.txHash ?? d.id,
      amount: Number(formatUnits(BigInt(d.amount ?? "0"), 18)),
      yesPrice,
      refundAmountWad: surplus && surplus > 0n ? surplus : null,
      timestamp: Number(d.blockNumber ?? "0"),
      sortKey: Number(d.blockNumber ?? "0") * 10_000,
    };
  }

  return null;
}

async function fetchOpenOrdersFromRpc(
  publicClient: PublicClient,
  soothBookAddress: Address,
  marketKey: `0x${string}`,
  ownerLower: `0x${string}`,
  marketAddress: `0x${string}`,
  chainId: number | undefined,
): Promise<OpenOrder[]> {
  const latest = await publicClient.getBlockNumber();
  const { fromBlock, chunkSize } = getFallbackWindow(chainId, latest);
  const ranges = getScanRanges(fromBlock, latest, chunkSize);

  const levels = new Map<
    string,
    {
      side: 0 | 1;
      tick: number;
      placed: bigint;
      cancelled: bigint;
      filled: bigint;
      lastBlock: bigint;
    }
  >();

  for (const range of ranges) {
    const [placed, cancelled, filled] = await Promise.all([
      publicClient.getLogs({
        address: soothBookAddress,
        event: ORDER_PLACED,
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
      publicClient.getLogs({
        address: soothBookAddress,
        event: ORDER_FILLED,
        args: { marketKey, maker: ownerLower },
        fromBlock: range.from,
        toBlock: range.to,
      }),
    ]);

    const upsert = (
      side: 0 | 1,
      tick: number,
      blockNumber: bigint | null | undefined,
    ) => {
      const key = `${side}:${tick}`;
      const existing = levels.get(key);
      if (existing) {
        if (blockNumber && blockNumber > existing.lastBlock)
          existing.lastBlock = blockNumber;
        return existing;
      }
      const created = {
        side,
        tick,
        placed: 0n,
        cancelled: 0n,
        filled: 0n,
        lastBlock: blockNumber ?? 0n,
      };
      levels.set(key, created);
      return created;
    };

    for (const log of placed) {
      const side = Number(log.args.side ?? 0) as 0 | 1;
      const tick = Number(log.args.tick ?? 0);
      const entry = upsert(side, tick, log.blockNumber);
      entry.placed += log.args.amount ?? 0n;
    }

    for (const log of cancelled) {
      const side = Number(log.args.side ?? 0) as 0 | 1;
      const tick = Number(log.args.tick ?? 0);
      const entry = upsert(side, tick, log.blockNumber);
      entry.cancelled += log.args.amount ?? 0n;
    }

    for (const log of filled) {
      const takerSide = Number(log.args.takerSide ?? 0);
      const makerSide: 0 | 1 = takerSide === 1 ? 0 : 1;
      const makerTick = Number(
        takerSide === 1 ? (log.args.noTick ?? 0) : (log.args.yesTick ?? 0),
      );
      const entry = upsert(makerSide, makerTick, log.blockNumber);
      entry.filled += log.args.amount ?? 0n;
    }
  }

  const openOrders: OpenOrder[] = [];
  for (const level of levels.values()) {
    const remaining = level.placed - level.cancelled - level.filled;
    if (remaining <= 0n) continue;

    const initial = level.placed;
    const fillPct =
      initial > 0n
        ? Number(((initial - remaining) * 10_000n) / initial) / 100
        : 0;
    const yesPrice =
      level.side === 1
        ? tickToYesPrice(level.tick, 1)
        : tickToYesPrice(level.tick, 0);

    openOrders.push({
      id: `${level.side}:${level.tick}`,
      outcome: level.side,
      yesPrice,
      amount: Number(formatUnits(remaining, 18)),
      fillPct: clampPercent(fillPct),
      timestamp: Number(level.lastBlock),
      isBuy: true,
      marketAddress,
      marketName: truncateAddress(marketAddress),
    });
  }

  return openOrders.sort((a, b) => b.timestamp - a.timestamp);
}

async function fetchHistoryRowsFromRpc(
  publicClient: PublicClient,
  soothBookAddress: Address,
  marketKey: `0x${string}`,
  ownerLower: `0x${string}`,
  chainId: number | undefined,
): Promise<HistoryRow[]> {
  const latest = await publicClient.getBlockNumber();
  const { fromBlock, chunkSize } = getFallbackWindow(chainId, latest);
  const ranges = getScanRanges(fromBlock, latest, chunkSize);

  const rows = new Map<string, HistoryRow>();

  const upsert = (key: string, row: HistoryRow) => {
    const existing = rows.get(key);
    if (!existing || row.sortKey > existing.sortKey) {
      rows.set(key, row);
    }
  };

  for (const range of ranges) {
    const [placed, cancelled, filledAsMaker, filledAsTaker] =
      await Promise.all([
      publicClient.getLogs({
        address: soothBookAddress,
        event: ORDER_PLACED,
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
      publicClient.getLogs({
        address: soothBookAddress,
        event: ORDER_FILLED,
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
    ]);

    for (const log of placed) {
      const side: "YES" | "NO" =
        Number(log.args.side ?? 0) === 1 ? "YES" : "NO";
      const tick = Number(log.args.tick ?? 0);
      const sortKey = Number(
        (log.blockNumber ?? 0n) * 10_000n + BigInt(log.logIndex ?? 0),
      );
      upsert(`${log.transactionHash}-${log.logIndex}-placed`, {
        key: `${log.transactionHash}-${log.logIndex}-placed`,
        type: "placed",
        side,
        orderId: String(log.args.orderId ?? `${Number(log.args.side ?? 0)}:${tick}`),
        orderRef: log.transactionHash,
        amount: Number(formatUnits(log.args.amount ?? 0n, 18)),
        yesPrice:
          Number(log.args.side ?? 0) === 1
            ? tickToYesPrice(tick, 1)
            : tickToYesPrice(tick, 0),
        refundAmountWad: null,
        timestamp: Number(log.blockNumber ?? 0n),
        sortKey,
      });
    }

    for (const log of cancelled) {
      const side: "YES" | "NO" =
        Number(log.args.side ?? 0) === 1 ? "YES" : "NO";
      const tick = Number(log.args.tick ?? 0);
      const sortKey = Number(
        (log.blockNumber ?? 0n) * 10_000n + BigInt(log.logIndex ?? 0),
      );
      upsert(`${log.transactionHash}-${log.logIndex}-cancelled`, {
        key: `${log.transactionHash}-${log.logIndex}-cancelled`,
        type: "cancelled",
        side,
        orderId: String(log.args.orderId ?? `${Number(log.args.side ?? 0)}:${tick}`),
        orderRef: log.transactionHash,
        amount: Number(formatUnits(log.args.amount ?? 0n, 18)),
        yesPrice:
          Number(log.args.side ?? 0) === 1
            ? tickToYesPrice(tick, 1)
            : tickToYesPrice(tick, 0),
        refundAmountWad: null,
        timestamp: Number(log.blockNumber ?? 0n),
        sortKey,
      });
    }

    for (const log of [...filledAsMaker, ...filledAsTaker]) {
      const yesTick = Number(log.args.yesTick ?? 0);
      const sortKey = Number(
        (log.blockNumber ?? 0n) * 10_000n + BigInt(log.logIndex ?? 0),
      );
      upsert(`${log.transactionHash}-${log.logIndex}-filled`, {
        key: `${log.transactionHash}-${log.logIndex}-filled`,
        type: "filled",
        side: Number(log.args.takerSide ?? 0) === 1 ? "YES" : "NO",
        orderId: "",
        orderRef: log.transactionHash,
        amount: Number(formatUnits(log.args.amount ?? 0n, 18)),
        yesPrice: clampUnit(yesTick / 1000),
        refundAmountWad:
          (log.args.surplus ?? 0n) > 0n ? (log.args.surplus ?? 0n) : null,
        timestamp: Number(log.blockNumber ?? 0n),
        sortKey,
      });
    }
  }

  return Array.from(rows.values()).sort((a, b) => b.sortKey - a.sortKey);
}

export function useIndexerOrders(
  chainIdProp: number | undefined,
  marketKey: `0x${string}` | undefined,
  marketAddress: `0x${string}`,
  owner: `0x${string}` | undefined,
  soothBookAddress: `0x${string}` | undefined,
) {
  // Prefer the app-selected chain (store) over the caller's chainId so
  // browsing MegaETH with a wallet on a different chain reads from the
  // right RPC / indexer rows.
  const { selectedChainId } = useChainStore();
  const chainId = (chainIdProp ?? Number(selectedChainId)) || undefined;
  const ownerLower = owner?.toLowerCase();
  const publicClient = usePublicClient({ chainId });

  const {
    data: openOrdersData,
    isLoading: ordersLoading,
    refetch: refetchOrders,
  } = useQuery<OpenOrder[]>({
    queryKey: ["indexer-orders", chainId, marketKey, ownerLower],
    queryFn: async () => {
      if (!chainId || !marketKey || !ownerLower) return [] as OpenOrder[];
      // Use the owner-scoped endpoint so the filter by maker is actually
      // applied server-side. The market-wide `/v12/orders/:chainId/:marketKey`
      // route ignores `?maker=` and returns active orders from every maker —
      // fine when the only maker is the test wallet, broken in production.
      const orders = await fetchFromIndexer<IndexerOrder[]>(
        `/v12/orders/${chainId}/${marketKey}/${ownerLower}`,
      );
      if (orders !== null) {
        return orders
          .filter((o) => o.status === "active")
          .map((o) => orderToOpen(o, marketAddress));
      }

      if (!publicClient || !soothBookAddress) {
        return [] as OpenOrder[];
      }

      return fetchOpenOrdersFromRpc(
        publicClient,
        toHexAddress(soothBookAddress),
        marketKey,
        toHexAddress(ownerLower),
        marketAddress,
        chainId,
      );
    },
    enabled: !!chainId && !!marketKey && !!ownerLower,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  const {
    data: historyRowsData,
    isLoading: activityLoading,
    refetch: refetchActivity,
  } = useQuery<HistoryRow[]>({
    queryKey: ["indexer-activity", chainId, marketKey, ownerLower],
    queryFn: async () => {
      if (!chainId || !marketKey) return [] as HistoryRow[];
      const params = ownerLower
        ? `?maker=${ownerLower}&limit=200`
        : "?limit=200";
      const activity = await fetchFromIndexer<IndexerActivity[]>(
        `/v12/activity/${chainId}/${marketKey}${params}`,
      );
      if (activity !== null) {
        return activity
          .map(activityToHistory)
          .filter((r): r is HistoryRow => r !== null);
      }

      if (!publicClient || !soothBookAddress || !ownerLower) {
        return [] as HistoryRow[];
      }

      return fetchHistoryRowsFromRpc(
        publicClient,
        toHexAddress(soothBookAddress),
        marketKey,
        toHexAddress(ownerLower),
        chainId,
      );
    },
    enabled: !!chainId && !!marketKey && !!ownerLower,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  const openOrders: OpenOrder[] = openOrdersData ?? [];

  const historyRows: HistoryRow[] = historyRowsData ?? [];

  const refresh = async () => {
    await Promise.all([refetchOrders(), refetchActivity()]);
  };

  return {
    openOrders,
    historyRows,
    isLoading: ordersLoading || activityLoading,
    refresh,
  };
}
