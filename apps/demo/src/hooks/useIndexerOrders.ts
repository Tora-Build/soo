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
import { SIDE_BID } from "../lib/book-order-mapping";

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

/**
 * Open orders straight out of the redesigned book account.
 *
 * The legacy function below reconstructs them by replaying OrderPlaced /
 * OrderCancelled / OrdersFilled logs over a chunked getLogs scan and netting
 * per price level. That is event sourcing to answer a question the chain can
 * answer directly, and it can only ever produce a LEVEL — hence the
 * synthesised `${side}:${tick}` id, and the cancel-by-guess it forced.
 *
 * Here each order carries its real `seq`, which is what `book_cancel` takes.
 */
async function fetchOpenOrdersFromBook(
  publicClient: PublicClient,
  marketAddress: `0x${string}`,
  owner: `0x${string}`,
): Promise<OpenOrder[]> {
  const rows = (await (publicClient as unknown as {
    readContract: (args: unknown) => Promise<unknown>;
  }).readContract({
    address: marketAddress,
    abi: [],
    functionName: "getMyOpenOrders",
    args: [marketAddress, owner],
  })) as Array<{ seq: bigint; side: number; priceTick: number; amount: bigint }>;

  return rows.map((o) => ({
    // The real sequence. Nothing synthesised, nothing to parse back.
    id: o.seq.toString(),
    // `OpenOrder.outcome` follows the LEGACY convention, where 1 is the YES
    // side — `tickToYesPrice(tick, 1)` returns the tick as a YES price, and
    // the panel reads `sideIsYes = outcome === 1`.
    //
    // The redesigned book numbers its sides the other way round: 0 is
    // SIDE_BID, which BUYS YES. Passing the book's side straight through
    // inverted every row — a resting bid rendered as "Sell" in the YES tab and
    // "Buy" in the NO tab, at prices that looked plausible either way.
    outcome: (o.side === SIDE_BID ? 1 : 0) as 0 | 1,
    // One axis: a bid at 400 and an ask at 400 are both "YES at 0.40".
    yesPrice: clampUnit(o.priceTick / 1000),
    // The book counts in USDC base units (1e6), not WAD.
    amount: Number(o.amount) / 1e6,
    // Partial fills decrement `amount` in place, so what remains IS the
    // unfilled size — there is no separate filled counter to net against.
    fillPct: 0,
    timestamp: Number(o.seq),
    isBuy: o.side === SIDE_BID,
    marketAddress,
    marketName: truncateAddress(marketAddress),
  }));
}


/**
 * Order history from the redesigned book's own events.
 *
 * There is no indexer on the Solana fork, so this reads the book PDA's
 * transaction signatures and decodes the CPI events the program emits. That is
 * bounded work per call, not an index — deep history needs a real indexer.
 */
async function fetchHistoryFromBook(
  publicClient: PublicClient,
  marketAddress: `0x${string}`,
  owner: `0x${string}`,
): Promise<HistoryRow[]> {
  const rows = (await (publicClient as unknown as {
    readContract: (args: unknown) => Promise<unknown>;
  }).readContract({
    address: marketAddress,
    abi: [],
    functionName: "getMyOrderHistory",
    args: [marketAddress, owner],
  })) as Array<{
    signature: string;
    type: "placed" | "filled" | "cancelled";
    role?: "maker" | "taker";
    seq: bigint;
    side: number | null;
    priceTick: number | null;
    amount: bigint;
    refund?: bigint;
    ts: bigint;
  }>;

  return rows.map((r, i) => {
    // One transaction can produce several rows (a taker crossing three resting
    // orders), so the signature alone is not unique.
    const key = `${r.signature}:${r.type}:${r.seq}:${i}`;
    const ts = Number(r.ts);
    return {
      key,
      type: r.type,
      // The book quotes one YES axis; side 0 is a bid (long YES).
      side: r.side === 1 ? "NO" : "YES",
      orderId: r.seq.toString(),
      orderRef: r.signature,
      amount: Number(r.amount) / 1e6,
      yesPrice: r.priceTick === null ? 0 : clampUnit(r.priceTick / 1000),
      refundAmountWad: r.refund && r.refund > 0n ? r.refund * 10n ** 12n : null,
      timestamp: ts,
      sortKey: ts,
    } satisfies HistoryRow;
  });
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
  // EVM addresses are hex and case-insensitive, so lowercasing is free — and
  // the indexer stores them lowercased, so its routes need it.
  const ownerLower = owner?.toLowerCase();
  // Solana pubkeys are base58 and case-SENSITIVE. Lowercasing one produces a
  // string that matches no trader on the book, which is a silently empty panel
  // rather than an error. Keep the original for every Solana-side read.
  const ownerExact = owner;
  const publicClient = usePublicClient({ chainId });

  const {
    data: openOrdersData,
    isLoading: ordersLoading,
    refetch: refetchOrders,
  } = useQuery<OpenOrder[]>({
    queryKey: ["indexer-orders", chainId, marketKey, ownerLower, ownerExact],
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

      // One account read. Orders live in the book account, so there is
      // nothing to reconstruct.
      return fetchOpenOrdersFromBook(
        publicClient,
        marketAddress,
        ownerExact as `0x${string}`,
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
    queryKey: ["indexer-activity", chainId, marketKey, ownerLower, ownerExact],
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

      // History comes from the book's own CPI events.
      return fetchHistoryFromBook(
        publicClient,
        marketAddress,
        ownerExact as `0x${string}`,
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
