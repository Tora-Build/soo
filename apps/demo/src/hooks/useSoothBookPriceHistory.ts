import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "@/lib/chain-shim";
import {
  checkChainReady,
  fetchFromIndexer,
  USE_INDEXER,
} from "./indexer/config";

export type CandleInterval = "5s" | "1m" | "15m" | "1h";

export type PriceCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint;
  trades: number;
};

type IndexedFill = {
  yesTick: number;
  amount: string;
  timestamp: string;
};

const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  "5s": 5,
  "1m": 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
};

function aggregateFillsToCandles(
  fills: IndexedFill[],
  interval: CandleInterval,
): PriceCandle[] {
  const intervalSeconds = INTERVAL_SECONDS[interval];
  const sorted = [...fills]
    .map((fill) => ({
      yesTick: Number(fill.yesTick),
      amount: BigInt(fill.amount),
      timestamp: Number(fill.timestamp),
    }))
    .filter(
      (fill) =>
        Number.isFinite(fill.yesTick) &&
        Number.isFinite(fill.timestamp) &&
        fill.timestamp > 0,
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  const buckets = new Map<number, PriceCandle>();

  for (const fill of sorted) {
    const bucketTs =
      Math.floor(fill.timestamp / intervalSeconds) * intervalSeconds;
    const price = Math.max(0.001, Math.min(0.999, fill.yesTick / 1000));
    const existing = buckets.get(bucketTs);
    if (!existing) {
      buckets.set(bucketTs, {
        timestamp: bucketTs,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: fill.amount,
        trades: 1,
      });
      continue;
    }

    existing.high = Math.max(existing.high, price);
    existing.low = Math.min(existing.low, price);
    existing.close = price;
    existing.volume += fill.amount;
    existing.trades += 1;
  }

  return Array.from(buckets.values()).sort((a, b) => a.timestamp - b.timestamp);
}

export function useSoothBookPriceHistory(
  chainId: number | undefined,
  marketKey: `0x${string}` | undefined,
  interval: CandleInterval,
) {
  useQuery({
    queryKey: ["indexer-chain-ready-price-history", chainId],
    queryFn: () => checkChainReady(chainId!),
    enabled: USE_INDEXER && !!chainId,
    staleTime: 10_000,
  });

  const {
    data: candles,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["soothbook-price-history", chainId, marketKey, interval],
    queryFn: async () => {
      if (!chainId || !marketKey) return [] as PriceCandle[];
      const fills = await fetchFromIndexer<IndexedFill[]>(
        `/v12/fills/${chainId}/${marketKey}?limit=2000`,
      );
      if (!fills || fills.length === 0) return [] as PriceCandle[];
      const aggregated = aggregateFillsToCandles(fills, interval);
      return aggregated;
    },
    enabled: USE_INDEXER && !!chainId && !!marketKey,
    // Match the orderbook poll cadence (~10s) so the chart doesn't lag the
    // book/liquidity-map by 10–20 seconds. Drop further (e.g. 5_000) for
    // 5s-bucket mode if the indexer can sustain the load.
    staleTime: 5_000,
    refetchInterval: 5_000,
  });

  const history = candles ?? [];
  const first = history[0];
  const last = history[history.length - 1];

  const priceDelta = first && last ? last.close - first.open : 0;
  const changePct =
    first && first.open > 0 ? (priceDelta / first.open) * 100 : 0;
  const totalVolume = history.reduce((sum, candle) => sum + candle.volume, 0n);
  const totalTrades = history.reduce((sum, candle) => sum + candle.trades, 0);
  const high = history.reduce((max, candle) => Math.max(max, candle.high), 0);
  const low = history.reduce((min, candle) => Math.min(min, candle.low), 1);

  return {
    candles: history,
    isLoading,
    refetch,
    lastPrice: last?.close ?? null,
    changePct,
    changeCents: priceDelta * 100,
    totalVolumeShares: Number(formatUnits(totalVolume, 18)),
    totalTrades,
    high: history.length > 0 ? high : null,
    low: history.length > 0 ? low : null,
  };
}
