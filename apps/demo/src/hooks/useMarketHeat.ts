import type { Address } from "@/lib/chain-shim";
import { useChainStore } from "../store/useChainStore";
import { useDeployments } from "./useDeployments";
import { ABIS } from "../config/abis";
import { useDirectRead, readContractSafe } from "./useDirectRead";

/**
 * Trading heat per market, for "hottest first" ordering.
 *
 * The proxy is accumulated AMM fees (`getGraduationProgress`'s first slot):
 * fees are a fixed cut of every curve trade, so they are volume wearing a
 * different unit — and they are already on-chain per market, needing no
 * indexer. Two honest limits, accepted: post-graduation BOOK volume is not
 * captured (a graduated market's heat froze at its threshold — which still
 * ranks it above every colder bonding market, the ordering that matters),
 * and heat never decays (an old busy market outranks a new busy one; with a
 * devnet-sized inventory that is fine, and decay needs trade timestamps this
 * data cannot carry).
 *
 * One batched query for the whole list, keyed by the address set, so the
 * deck and the explorer share a single fetch per poll window.
 */
export function useMarketHeat(addresses: Array<string | Address>): {
  heatByAddress: Record<string, number>;
  hasLoaded: boolean;
} {
  const { selectedChainId } = useChainStore();
  const chainId =
    typeof selectedChainId === "number"
      ? selectedChainId
      : Number(selectedChainId);
  const deployments = useDeployments();
  const feeRouterAddress = deployments?.contracts?.FeeRouter as
    | Address
    | undefined;

  const sorted = [...new Set(addresses.map((a) => String(a).toLowerCase()))].sort();

  const query = useDirectRead<Record<string, number>>({
    queryKey: ["market-heat", chainId, feeRouterAddress, sorted.join(",")],
    enabled: sorted.length > 0 && !!feeRouterAddress,
    chainId,
    staleTime: 60_000,
    read: async (client) => {
      const out: Record<string, number> = {};
      await Promise.all(
        sorted.map(async (addr) => {
          const result = await readContractSafe<
            readonly [bigint, bigint, bigint]
          >(client, {
            address: feeRouterAddress!,
            abi: ABIS.FeeRouter,
            functionName: "getGraduationProgress",
            args: [addr as Address],
          }).catch(() => null);
          // WAD fees → whole-token units; ordering only needs the ratio.
          out[addr] = result ? Number(result[0] / 10n ** 12n) / 1e6 : 0;
        }),
      );
      return out;
    },
  });

  return {
    heatByAddress: query.data ?? {},
    hasLoaded: query.data !== undefined,
  };
}
