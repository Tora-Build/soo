import { usePublicClient, useBlockNumber } from '@/lib/chain-shim';

/**
 * RPC connection status and current block number.
 * Compared against indexer status to show sync lag.
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
