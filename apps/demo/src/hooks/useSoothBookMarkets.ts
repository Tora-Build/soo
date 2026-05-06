import { useQuery } from '@tanstack/react-query';
import { fetchFromIndexer, checkChainReady, USE_INDEXER } from './indexer/config';

export interface IndexedMarket {
  marketKey: `0x${string}`;
  chainId: number;
  collateral: string;
  yesToken: string;
  noToken: string;
  active: boolean;
  finalized: boolean;
  outcome: number | null;
  createdAt: string;
  blockNumber: string;
}

export function useSoothBookMarkets(chainId: number | undefined) {
  useQuery({
    queryKey: ['indexer-chain-ready', chainId],
    queryFn: () => checkChainReady(chainId!),
    enabled: USE_INDEXER && !!chainId,
    staleTime: 10_000,
  });

  const { data: markets, isLoading } = useQuery({
    queryKey: ['soothbook-markets', chainId],
    queryFn: () => fetchFromIndexer<IndexedMarket[]>(`/v12/markets/${chainId}`),
    enabled: USE_INDEXER && !!chainId,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const marketKeys = (markets ?? [])
    .filter((m) => m.active)
    .map((m) => m.marketKey);

  return { markets: markets ?? [], marketKeys, isLoading };
}
