import { useQuery } from "@tanstack/react-query";
import { clampUnit } from "../lib/orderbook-math";
import { usePublicClient } from "@/lib/chain-shim";
import { shortenAddress as truncateAddress } from "../utils/format";
import { useChainStore } from "../store/useChainStore";
import { SIDE_BID } from "../lib/book-order-mapping";

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

/**
 * Open orders straight out of the book account.
 *
 * Preferred over the log-replay fallback below, which nets OrderPlaced /
 * OrderCancelled / OrdersFilled per price level and so can only ever produce
 * a LEVEL — a synthesised `${side}:${tick}` id that forces cancel-by-guess.
 *
 * Here each order carries its real `seq`, which is what `book_cancel` takes.
 */
export async function fetchOpenOrdersFromBook(
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
  })) as Array<{
    seq: bigint;
    side: number;
    priceTick: number;
    amount: bigint;
    placedAmount?: bigint;
  }>;

  return rows.map((o) => ({
    // The real sequence. Nothing synthesised, nothing to parse back.
    id: o.seq.toString(),
    // `OpenOrder.outcome` follows the EVM-shaped convention, where 1 is the
    // YES side — `tickToYesPrice(tick, 1)` returns the tick as a YES price,
    // and the panel reads `sideIsYes = outcome === 1`.
    //
    // The book numbers its sides the other way round: 0 is SIDE_BID, which
    // BUYS YES. So the two must be translated here; passing the book's side
    // straight through inverts every row — a resting bid renders as "Sell" in
    // the YES tab and "Buy" in the NO tab, at plausible-looking prices.
    outcome: (o.side === SIDE_BID ? 1 : 0) as 0 | 1,
    // One axis: a bid at 400 and an ask at 400 are both "YES at 0.40".
    yesPrice: clampUnit(o.priceTick / 1000),
    // The book counts in USDC base units (1e6), not WAD.
    amount: Number(o.amount) / 1e6,
    // The book stores only what REMAINS, so the fill fraction needs the size
    // at placement, which comes from the `placed` event. Without it every
    // partially-filled order read as 0% — the order visibly shrank in the
    // ladder while its own row claimed nothing had happened.
    fillPct: (() => {
      const placed = o.placedAmount ?? o.amount;
      if (placed <= 0n) return 0;
      const filled = placed > o.amount ? placed - o.amount : 0n;
      return clampPercent(Number((filled * 10_000n) / placed) / 100);
    })(),
    timestamp: Number(o.seq),
    isBuy: o.side === SIDE_BID,
    marketAddress,
    marketName: truncateAddress(marketAddress),
  }));
}


/**
 * Order history from the book's own events.
 *
 * Reads the book PDA's transaction signatures and decodes the CPI events the
 * program emits. That is bounded work per call, not an index: history reaches
 * only as far back as the RPC retains signatures for the account.
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


export function useBookOrders(
  chainIdProp: number | undefined,
  marketKey: `0x${string}` | undefined,
  marketAddress: `0x${string}`,
  owner: `0x${string}` | undefined,
  soothBookAddress: `0x${string}` | undefined,
) {
  // Prefer the app-selected chain (store) over the caller's chainId so the
  // reads follow the chain the user is browsing, not the wallet's.
  const { selectedChainId } = useChainStore();
  const chainId = (chainIdProp ?? Number(selectedChainId)) || undefined;
  const publicClient = usePublicClient({ chainId });

  const {
    data: openOrdersData,
    isLoading: ordersLoading,
    refetch: refetchOrders,
  } = useQuery<OpenOrder[]>({
    queryKey: ["book-open-orders", chainId, marketKey, owner],
    queryFn: async () => {
      if (!publicClient || !soothBookAddress || !owner) {
        return [] as OpenOrder[];
      }

      // One account read. Orders live in the book account, so there is
      // nothing to reconstruct.
      return fetchOpenOrdersFromBook(publicClient, marketAddress, owner);
    },
    enabled: !!chainId && !!marketKey && !!owner,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  const {
    data: historyRowsData,
    isLoading: activityLoading,
    refetch: refetchActivity,
  } = useQuery<HistoryRow[]>({
    queryKey: ["book-order-history", chainId, marketKey, owner],
    queryFn: async () => {
      if (!publicClient || !soothBookAddress || !owner) {
        return [] as HistoryRow[];
      }

      // History comes from the book's own CPI events.
      return fetchHistoryFromBook(publicClient, marketAddress, owner);
    },
    enabled: !!chainId && !!marketKey && !!owner,
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
