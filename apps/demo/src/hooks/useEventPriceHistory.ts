/**
 * useEventPriceHistory — fetch AMM trade history for N markets in parallel
 * (one indexer query per market via React Query) and pick the shortest
 * candle interval that any market can satisfy with ≥2 buckets.
 *
 * Mirrors the auto-interval mechanism in AmmHistoricalPriceCard so the
 * event chart never renders an empty timeframe.
 */
import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  checkChainReady,
  INDEXER_TIMEOUT,
  INDEXER_URL,
  USE_INDEXER,
} from "./indexer/config";

export type CandleInterval = "1m" | "15m" | "1h" | "4h";
const INTERVALS: CandleInterval[] = ["1m", "15m", "1h", "4h"];
const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  "1m": 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
};

export type PricePoint = {
  timestamp: number;
  price: number; // 0..1
};

type IndexedAmmTrade = {
  yesProbability: number;
  cost: string;
  timestamp: string;
};

function bucketTrades(
  trades: IndexedAmmTrade[],
  interval: CandleInterval,
): PricePoint[] {
  const seconds = INTERVAL_SECONDS[interval];
  const buckets = new Map<number, number>();
  for (const t of trades) {
    const ts = Number(t.timestamp);
    const price = Number(t.yesProbability);
    if (!Number.isFinite(ts) || !Number.isFinite(price) || ts <= 0) continue;
    const bucket = Math.floor(ts / seconds) * seconds;
    // Use last price in the bucket as close
    buckets.set(bucket, Math.max(0.001, Math.min(0.999, price)));
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, price]) => ({ timestamp, price }));
}

async function fetchTrades(
  chainId: number,
  market: string,
): Promise<IndexedAmmTrade[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INDEXER_TIMEOUT);
  try {
    const res = await fetch(`${INDEXER_URL}/amm-trades/${chainId}/${market}`, {
      signal: controller.signal,
    });
    if (!res.ok) return [];
    return (await res.json()) as IndexedAmmTrade[];
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface EventPriceSeries {
  market: string;
  points: PricePoint[];
}

export function useEventPriceHistory(
  chainId: number | undefined,
  markets: string[],
) {
  const readinessQuery = useQuery({
    queryKey: ["indexer-chain-ready-event-history", chainId],
    queryFn: () => checkChainReady(chainId!),
    enabled: USE_INDEXER && !!chainId,
    staleTime: 10_000,
  });

  const queries = useQueries({
    queries: markets.map((market) => ({
      queryKey: ["amm-price-history", chainId, market.toLowerCase()],
      queryFn: () => fetchTrades(chainId!, market),
      enabled:
        USE_INDEXER &&
        !!chainId &&
        !!market &&
        readinessQuery.data === true &&
        !readinessQuery.isLoading,
      staleTime: 20_000,
      refetchInterval: 30_000,
    })),
  });

  const tradesByMarket = useMemo(() => {
    return markets.map((m, i) => ({
      market: m,
      trades: (queries[i]?.data ?? []) as IndexedAmmTrade[],
    }));
  }, [markets, queries]);

  // Pick the shortest interval where ANY market produces >=2 buckets.
  // Falls back to "4h" when no market has enough data.
  const interval: CandleInterval = useMemo(() => {
    for (const i of INTERVALS) {
      const anyHasData = tradesByMarket.some(
        ({ trades }) => bucketTrades(trades, i).length >= 2,
      );
      if (anyHasData) return i;
    }
    return "4h";
  }, [tradesByMarket]);

  const series: EventPriceSeries[] = useMemo(() => {
    return tradesByMarket.map(({ market, trades }) => ({
      market,
      points: bucketTrades(trades, interval),
    }));
  }, [tradesByMarket, interval]);

  const isLoading = queries.some((q) => q.isLoading);
  const totalPoints = series.reduce((sum, s) => sum + s.points.length, 0);

  return { series, interval, isLoading, totalPoints };
}
