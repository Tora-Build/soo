import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { encodePacked, keccak256 } from "@/lib/chain-shim";
import {
  normalizeIndexerAmmTrades,
  normalizeIndexerFills,
  type IndexerAmmTrade,
  type IndexerFill,
  type LpObservedActivity,
} from "../lib/lp-forecast";
import { fetchFromIndexer, USE_INDEXER } from "./indexer/config";

export function useLpBacktestData(
  chainId: number | undefined,
  marketAddress: `0x${string}` | undefined,
) {
  const marketKey = useMemo(() => {
    if (!marketAddress) return undefined;
    return keccak256(encodePacked(["address"], [marketAddress]));
  }, [marketAddress]);

  const query = useQuery({
    queryKey: ["lp-backtest-data", chainId, marketAddress, marketKey],
    enabled: USE_INDEXER && !!chainId && !!marketAddress && !!marketKey,
    staleTime: 20_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!chainId || !marketAddress || !marketKey) {
        return [] as LpObservedActivity[];
      }

      const [ammTrades, fills] = await Promise.all([
        fetchFromIndexer<IndexerAmmTrade[]>(
          `/amm-trades/${chainId}/${marketAddress}`,
        ),
        fetchFromIndexer<IndexerFill[]>(
          `/v12/fills/${chainId}/${marketKey}?limit=2000`,
        ),
      ]);

      return [
        ...normalizeIndexerAmmTrades(ammTrades ?? []),
        ...normalizeIndexerFills(fills ?? []),
      ].sort((a, b) => a.timestamp - b.timestamp);
    },
  });

  const activities = query.data ?? [];
  return {
    activities,
    activityCount: activities.length,
    isEnabled: USE_INDEXER,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
