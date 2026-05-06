import { useAccount } from '@/lib/chain-shim';
import { useDirectRead, readContractSafe } from './useDirectRead';
import { ABIS } from '../config/abis';
import { useDeployments } from './useDeployments';
import { useChainStore } from '../store/useChainStore';

/**
 * Hook to fetch user's AMM position (YES and NO shares) for a specific market (V9 Architecture).
 */
export function useAMMPositionDirect(marketAddress?: `0x${string}`) {
  const { address: userAddress } = useAccount();
  const { selectedChainId } = useChainStore();
  const chainId = typeof selectedChainId === 'number' ? selectedChainId : Number(selectedChainId);
  const deployments = useDeployments();
  const ammEngineAddress = deployments?.contracts?.AMMEngine as `0x${string}`;

  return useDirectRead({
    queryKey: ['v9', 'ammPosition', chainId, ammEngineAddress, marketAddress, userAddress],
    enabled: !!marketAddress && !!chainId && !!ammEngineAddress && !!userAddress,
    chainId,
    read: async (client) => {
      // getPosition returns (uint256 yesShares, uint256 noShares)
      const result = await readContractSafe<readonly [bigint, bigint]>(client, {
        address: ammEngineAddress!,
        abi: ABIS.AMMEngine,
        functionName: 'getPosition',
        args: [marketAddress, userAddress],
      });

      const [yesShares, noShares] = result ?? [0n, 0n];
      return {
        yesShares,
        noShares,
        shares: yesShares + noShares,
      };
    },
  });
}

