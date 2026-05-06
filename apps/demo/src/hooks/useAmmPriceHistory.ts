import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "@/lib/chain-shim";
import {
  checkChainReady,
  INDEXER_TIMEOUT,
  INDEXER_URL,
  USE_INDEXER,
} from "./indexer/config";

export type CandleInterval = "1m" | "15m" | "1h" | "4h";

export type PriceCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint;
  trades: number;
};

type IndexedAmmTrade = {
  yesProbability: number;
  cost: string;
  timestamp: string;
};

const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  "1m": 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
};

function aggregateAmmTradesToCandles(
  trades: IndexedAmmTrade[],
  interval: CandleInterval,
): PriceCandle[] {
  const intervalSeconds = INTERVAL_SECONDS[interval];
  const sorted = [...trades]
    .map((trade) => ({
      price: Number(trade.yesProbability),
      cost: BigInt(trade.cost),
      timestamp: Number(trade.timestamp),
    }))
    .filter(
      (t) =>
        Number.isFinite(t.price) &&
        Number.isFinite(t.timestamp) &&
        t.timestamp > 0,
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  const buckets = new Map<number, PriceCandle>();

  for (const trade of sorted) {
    const bucketTs =
      Math.floor(trade.timestamp / intervalSeconds) * intervalSeconds;
    const price = Math.max(0.001, Math.min(0.999, trade.price));
    const absCost = trade.cost < 0n ? -trade.cost : trade.cost;
    const existing = buckets.get(bucketTs);
    if (!existing) {
      buckets.set(bucketTs, {
        timestamp: bucketTs,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: absCost,
        trades: 1,
      });
      continue;
    }

    existing.high = Math.max(existing.high, price);
    existing.low = Math.min(existing.low, price);
    existing.close = price;
    existing.volume += absCost;
    existing.trades += 1;
  }

  return Array.from(buckets.values()).sort((a, b) => a.timestamp - b.timestamp);
}

export function useAmmPriceHistory(
  chainId: number | undefined,
  market: `0x${string}` | undefined,
  interval: CandleInterval,
) {
  const readinessQuery = useQuery({
    queryKey: ["indexer-chain-ready-amm-history", chainId],
    queryFn: () => checkChainReady(chainId!),
    enabled: USE_INDEXER && !!chainId,
    staleTime: 10_000,
  });

  const {
    data: indexedTrades,
    error,
    isError,
    isLoading: isHistoryLoading,
    refetch,
  } = useQuery({
    queryKey: ["amm-price-history", chainId, market],
    queryFn: async () => {
      if (!chainId || !market) {
        return [] as IndexedAmmTrade[];
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), INDEXER_TIMEOUT);

      try {
        const response = await fetch(
          `${INDEXER_URL}/amm-trades/${chainId}/${market}`,
          {
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          throw new Error(`Indexer returned HTTP ${response.status}`);
        }

        return (await response.json()) as IndexedAmmTrade[];
      } finally {
        clearTimeout(timeoutId);
      }
    },
    enabled:
      USE_INDEXER &&
      !!chainId &&
      !!market &&
      readinessQuery.data === true &&
      !readinessQuery.isLoading,
    staleTime: 20_000,
    refetchInterval: 20_000,
  });

  const rawTradeCount = indexedTrades?.length ?? 0;
  const history = useMemo(
    () => aggregateAmmTradesToCandles(indexedTrades ?? [], interval),
    [indexedTrades, interval],
  );
  // Count candle buckets for every supported interval so the UI can
  // disable interval buttons that cannot produce a meaningful chart
  // (fewer than 2 buckets). This is the honest answer to sparse data:
  // only let the user pick intervals whose label actually matches
  // what will be rendered.
  const bucketCountByInterval = useMemo(() => {
    const trades = indexedTrades ?? [];
    return {
      "1m": aggregateAmmTradesToCandles(trades, "1m").length,
      "15m": aggregateAmmTradesToCandles(trades, "15m").length,
      "1h": aggregateAmmTradesToCandles(trades, "1h").length,
      "4h": aggregateAmmTradesToCandles(trades, "4h").length,
    } satisfies Record<CandleInterval, number>;
  }, [indexedTrades]);
  const hasHistoryData = history.length > 0;
  const first = history[0];
  const last = history[history.length - 1];
  const readinessError =
    readinessQuery.error instanceof Error ? readinessQuery.error : null;
  const historyError = error instanceof Error ? error : null;
  const isChainReady = readinessQuery.data === true;
  const isSyncing =
    !hasHistoryData &&
    USE_INDEXER &&
    !!chainId &&
    !isChainReady &&
    !readinessQuery.isError &&
    !readinessQuery.isLoading;
  const isLoading =
    !hasHistoryData &&
    (readinessQuery.isLoading || (isChainReady && isHistoryLoading));
  const errorMessage = readinessError?.message ?? historyError?.message ?? null;
  const hasRefreshError =
    hasHistoryData &&
    (!!historyError ||
      readinessQuery.isError ||
      (!isChainReady && !readinessQuery.isLoading));
  const hasBlockingError =
    (!hasHistoryData && readinessQuery.isError) ||
    (!!historyError && !hasHistoryData);

  const priceDelta = first && last ? last.close - first.open : 0;
  const changePct =
    first && first.open > 0 ? (priceDelta / first.open) * 100 : 0;
  const totalVolume = history.reduce((sum, candle) => sum + candle.volume, 0n);
  const totalTrades = history.reduce((sum, candle) => sum + candle.trades, 0);
  const high = history.reduce((max, candle) => Math.max(max, candle.high), 0);
  const low = history.reduce((min, candle) => Math.min(min, candle.low), 1);

  return {
    candles: history,
    bucketCountByInterval,
    errorMessage,
    isChainReady,
    isError: hasBlockingError,
    isLoading,
    isRefreshError: hasRefreshError,
    isSyncing,
    rawTradeCount,
    refetch,
    lastPrice: last?.close ?? null,
    changePct,
    changeCents: priceDelta * 100,
    totalVolumeWad: Number(formatUnits(totalVolume, 18)),
    totalTrades,
    high: history.length > 0 ? high : null,
    low: history.length > 0 ? low : null,
  };
}
