import type { Address } from "@/lib/chain-shim";
import { useChainStore } from "../store/useChainStore";
import { useDeployments } from "./useDeployments";
import { ABIS } from "../config/abis";
import { useDirectRead, readContractSafe } from "./useDirectRead";

/**
 * Lightweight hook that reads ONLY `FeeRouter.getGraduationProgress` for
 * a single market and returns the bonding-curve graduation percentage
 * (0–100). Designed for card-grid use where we need per-market
 * graduation progress without the full weight of `useLaunchpadMarketDirect`
 * (which pulls lpToken balances, trial state, creator position, fees,
 * market struct, etc. — overkill for a UI ring).
 *
 * The query is disabled for non-bonding markets (live / settled /
 * finalized / dismissed) — graduated markets render a full ring in the
 * component without needing a read.
 */
export function useGraduationRing(params: {
  marketAddress: Address | undefined;
  stage: string | undefined;
}) {
  const { marketAddress, stage } = params;
  const { selectedChainId } = useChainStore();
  const chainId =
    typeof selectedChainId === "number"
      ? selectedChainId
      : Number(selectedChainId);
  const deployments = useDeployments();
  const feeRouterAddress = deployments?.contracts?.FeeRouter as
    | Address
    | undefined;

  const needsRead = stage === "bonding";

  const query = useDirectRead<number>({
    queryKey: ["graduation-ring", chainId, feeRouterAddress, marketAddress],
    enabled: !!needsRead && !!marketAddress && !!feeRouterAddress,
    chainId,
    read: async (client) => {
      const result = await readContractSafe<readonly [bigint, bigint, bigint]>(
        client,
        {
          address: feeRouterAddress!,
          abi: ABIS.FeeRouter,
          functionName: "getGraduationProgress",
          args: [marketAddress!],
        },
      ).catch(() => [0n, 0n, 0n] as const);
      const progressBps = result?.[2] ?? 0n;
      return Math.min(100, Number(progressBps) / 100);
    },
    // Graduation progress moves slowly; poll less aggressively than the
    // default. 30s is fine.
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  return {
    /** 0–100 progress for bonding markets. `undefined` until the read lands. */
    progress: query.data,
    isLoading: query.isLoading,
  };
}
