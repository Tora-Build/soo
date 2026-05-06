import { useChainStore } from "../store/useChainStore";
import { useDeployments } from "./useDeployments";
import { ABIS } from "../config/abis";
import { useDirectRead, readContractSafe } from "./useDirectRead";

type Address = `0x${string}`;

export function useCollateralizerDirect(marketAddress: Address | undefined) {
  const { selectedChainId } = useChainStore();
  const chainId = typeof selectedChainId === "number" ? selectedChainId : Number(selectedChainId);
  const deployments = useDeployments();
  const collateralizerAddress = deployments?.contracts?.Collateralizer as Address | undefined;

  const query = useDirectRead({
    queryKey: ["v8", "collateralizerDirect", chainId, collateralizerAddress, marketAddress],
    enabled: !!marketAddress && !!chainId && !!collateralizerAddress,
    chainId,
    read: async (client) => {
      try {
        const [tokens, totalCollateral] = await Promise.all([
          readContractSafe<readonly [Address, Address]>(client, {
            address: collateralizerAddress!,
            abi: ABIS.Collateralizer,
            functionName: "getOutcomeTokens",
            args: [marketAddress!],
          }),
          readContractSafe<bigint>(client, {
            address: collateralizerAddress!,
            abi: ABIS.Collateralizer,
            functionName: "getTotalCollateral",
            args: [marketAddress!],
          }),
        ]);

        const [yesToken, noToken] = tokens;
        return {
          address: marketAddress!,
          yesToken,
          noToken,
          yesBalance: 0n,
          noBalance: 0n,
          totalCollateral,
          completeSetBalance: 0n,
          hasYesTokens: false,
          hasNoTokens: false,
          hasCompleteSets: false,
          canMerge: false,
          isRegistered: true,
        };
      } catch {
        // Pre-graduation markets aren't registered in Collateralizer yet
        const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
        return {
          address: marketAddress!,
          yesToken: ZERO_ADDRESS,
          noToken: ZERO_ADDRESS,
          yesBalance: 0n,
          noBalance: 0n,
          totalCollateral: 0n,
          completeSetBalance: 0n,
          hasYesTokens: false,
          hasNoTokens: false,
          hasCompleteSets: false,
          canMerge: false,
          isRegistered: false,
        };
      }
    },
  });

  return {
    collateralizer: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
