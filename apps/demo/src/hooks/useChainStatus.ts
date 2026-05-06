import { usePublicClient, useBlockNumber } from '@/lib/chain-shim';

/**
 * Hook to get RPC connection status and current block number
 * Used to compare against indexer status and show sync lag
 */
export const useChainStatus = () => {
  const publicClient = usePublicClient();
  const { data: blockNumber } = useBlockNumber({
    watch: true,
    cacheTime: 4_000, // Poll every 4 seconds
  });
  
  return {
    rpcBlock: blockNumber ? Number(blockNumber) : null,
    rpcConnected: !!publicClient,
  };
};
