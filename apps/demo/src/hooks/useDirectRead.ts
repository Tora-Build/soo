import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePublicClient } from "@/lib/chain-shim";
import type { Abi } from "@/lib/chain-shim";
import { useCallback } from "react";
import { getPollingInterval, getStaleTime } from "../lib/polling";

type Address = `0x${string}`;

const DEFAULT_REFETCH_INTERVAL = 15_000;
const DEFAULT_STALE_TIME = 5_000;

export function useDirectRead<TData>(params: {
  queryKey: readonly unknown[];
  enabled: boolean;
  chainId: number | undefined;
  read: (client: NonNullable<ReturnType<typeof usePublicClient>>) => Promise<TData>;
  refetchInterval?: number;
  staleTime?: number;
}) {
  const { queryKey, enabled, chainId, read, refetchInterval, staleTime } = params;
  const client = usePublicClient({ chainId });

  const defaultRefetchInterval = chainId ? getPollingInterval(chainId, 'normal') : DEFAULT_REFETCH_INTERVAL;
  const defaultStaleTime = chainId ? getStaleTime(chainId) : DEFAULT_STALE_TIME;

  return useQuery({
    queryKey,
    enabled: enabled && !!client,
    queryFn: async () => {
      return await read(client as NonNullable<typeof client>);
    },
    refetchInterval: refetchInterval ?? defaultRefetchInterval,
    staleTime: staleTime ?? defaultStaleTime,
  });
}

/**
 * Hook to invalidate all V8 and V9 queries - call after any transaction
 */
export function useInvalidateQueries() {
  const queryClient = useQueryClient();

  return useCallback(() => {
    // Invalidate all queries that start with 'v8' or 'v9'
    queryClient.invalidateQueries({ queryKey: ['v8'] });
    queryClient.invalidateQueries({ queryKey: ['v9'] });
  }, [queryClient]);
}

export async function readContractSafe<T>(client: any, req: {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}): Promise<T> {
  return (await client.readContract(req)) as T;
}
