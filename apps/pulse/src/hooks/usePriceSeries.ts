// The chart's data: the market's trade tape, fetched incrementally.
//
// `readMarketTrades` walks the market PDA's signatures and prices every
// event on the one YES axis (AMM exec prices + book fill ticks). We cache
// the assembled series per market and only ask the chain for signatures
// NEWER than the last one seen — the Polymarket chart without the indexer.
import { useQuery } from "@tanstack/react-query";
import { useAdapter } from "./useAdapter";

export interface PricePoint {
  ts: number;
  yesPriceWad: bigint;
  venue: "amm" | "book";
}

const seriesCache = new Map<
  string,
  { points: PricePoint[]; newest: string | undefined }
>();

export function usePriceSeries(ref: string | undefined) {
  const { adapter } = useAdapter();
  const query = useQuery({
    queryKey: ["pulse-series", ref],
    enabled: !!ref,
    refetchInterval: 10_000,
    queryFn: async () => {
      const cached = seriesCache.get(ref!) ?? {
        points: [],
        newest: undefined,
      };
      const fresh = await adapter.readMarketTrades(ref!, {
        limit: 300,
        until: cached.newest,
      });
      if (fresh.length > 0) {
        cached.points = [
          ...cached.points,
          ...fresh.map((t) => ({
            ts: t.ts,
            yesPriceWad: t.yesPriceWad,
            venue: t.venue,
          })),
        ].sort((a, b) => a.ts - b.ts);
        cached.newest = fresh[fresh.length - 1].signature;
        seriesCache.set(ref!, cached);
      }
      return [...cached.points];
    },
  });
  return { points: query.data ?? [], isLoading: query.isLoading };
}
