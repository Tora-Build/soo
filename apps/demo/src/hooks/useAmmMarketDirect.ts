import { useChainStore } from "../store/useChainStore";
import { useDeployments } from "./useDeployments";
import { ABIS, ERC20_ABI } from "../config/abis";
import { useDirectRead, readContractSafe } from "./useDirectRead";

type Address = `0x${string}`;

/**
 * Reads AMM market state straight off AMMEngine.
 */
export function useAmmMarketDirect(marketAddress: Address | undefined) {
  const { selectedChainId } = useChainStore();
  const chainId = typeof selectedChainId === "number" ? selectedChainId : Number(selectedChainId);
  const deployments = useDeployments();
  const ammEngineAddress = deployments?.contracts?.AMMEngine as Address | undefined;
  const usdcAddress = deployments?.contracts?.MockUSDC as Address | undefined;

  const query = useDirectRead({
    queryKey: ["v9", "ammMarketDirect", chainId, ammEngineAddress, marketAddress, usdcAddress],
    enabled: !!marketAddress && !!chainId && !!ammEngineAddress && !!usdcAddress,
    chainId,
    read: async (client) => {
      // Important: `getMarketState()` reverts if the market isn't initialized yet.
      const [liquidity, lockedProceeds] = await Promise.all([
        readContractSafe<bigint>(client, {
          address: ammEngineAddress!,
          abi: ABIS.AMMEngine,
          functionName: "getLiquidity",
          args: [marketAddress!],
        }),
        // Get USDC balance of AMMEngine (total locked proceeds across all users)
        readContractSafe<bigint>(client, {
          address: usdcAddress!,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [ammEngineAddress!],
        }),
      ]);

      const WAD = 10n ** 18n;
      const isInitialized = liquidity > 0n;

      let qYes = 0n;
      let qNo = 0n;
      let yesPrice = WAD / 2n;

      if (isInitialized) {
        const state = await readContractSafe<readonly [bigint, bigint, bigint]>(client, {
          address: ammEngineAddress!,
          abi: ABIS.AMMEngine,
          functionName: "getMarketState",
          args: [marketAddress!],
        });
        [qYes, qNo, yesPrice] = state;
      }

      const noPrice = yesPrice <= WAD ? WAD - yesPrice : 0n;
      const yesProbability = Number(yesPrice) / 1e18;
      const noProbability = Number(noPrice) / 1e18;
      return {
        address: marketAddress!,
        liquidity,
        isInitialized,
        qYes,
        qNo,
        yesPrice,
        noPrice,
        yesProbability,
        noProbability,
        hasLiquidity: qYes > 0n || qNo > 0n,
        isBalanced: Math.abs(yesProbability - 0.5) < 0.1,
        lockedProceeds,
      };
    },
  });

  return {
    amm: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
