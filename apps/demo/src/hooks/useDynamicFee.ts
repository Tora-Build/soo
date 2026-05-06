import { useChainStore } from "../store/useChainStore";
import { useDeployments } from "./useDeployments";
import { ABIS } from "../config/abis";
import { useDirectRead, readContractSafe } from "./useDirectRead";

type Address = `0x${string}`;

export interface DynamicFeeInfo {
  // Fee in basis points (e.g., 50 = 0.5%)
  feeBps: number;
  feePercent: string;

  // Fee config for this market
  baseFee: number;
  maxFee: number;
  volumeDiscount: number;
  volatilityPremium: number;

  // Computed breakdown
  effectiveDiscount: number;
  effectivePremium: number;
  breakdown: {
    base: string;
    discount: string;
    premium: string;
    final: string;
  };
}

/**
 * Hook to get dynamic fee information from DynamicFeeHook
 *
 * The hook adjusts fees based on:
 * - Volume: Higher volume = lower fees (rewards liquidity)
 * - Volatility: Higher volatility = higher fees (protects makers)
 */
export function useDynamicFee(
  marketKey: `0x${string}` | undefined,
  outcome: 0 | 1 = 0,
  shares: bigint = 0n,
  baseFee: number = 50 // Default 0.5%
) {
  const { selectedChainId } = useChainStore();
  const chainId = typeof selectedChainId === "number" ? selectedChainId : Number(selectedChainId);
  const deployments = useDeployments();
  const hookAddress = deployments?.contracts?.DynamicFeeHook as Address | undefined;

  const query = useDirectRead({
    queryKey: ["v9", "dynamicFee", chainId, hookAddress, marketKey, outcome, shares.toString(), baseFee],
    enabled: !!chainId && !!hookAddress && !!marketKey,
    chainId,
    read: async (client) => {
      // Get the dynamic fee for this trade
      const fee = await readContractSafe<number>(client, {
        address: hookAddress!,
        abi: ABIS.DynamicFeeHook,
        functionName: "getDynamicFee",
        args: [marketKey!, outcome, shares, baseFee],
      });

      // Get the fee config for this market
      const config = await readContractSafe<{
        baseFee: number;
        maxFee: number;
        volumeDiscount: number;
        volatilityPremium: number;
        windowStart: bigint;
        windowVolume: bigint;
        lastTick: number;
        tickMovement: number;
      }>(client, {
        address: hookAddress!,
        abi: ABIS.DynamicFeeHook,
        functionName: "feeConfigs",
        args: [marketKey!],
      });

      // Calculate effective discount and premium
      // These are approximate since the actual calculation is more complex
      const effectiveDiscount = Math.min(config.baseFee, config.volumeDiscount);
      const effectivePremium = Math.min(config.maxFee - config.baseFee, config.volatilityPremium);

      const formatBps = (bps: number) => `${(bps / 100).toFixed(2)}%`;

      return {
        feeBps: fee,
        feePercent: formatBps(fee),
        baseFee: config.baseFee,
        maxFee: config.maxFee,
        volumeDiscount: config.volumeDiscount,
        volatilityPremium: config.volatilityPremium,
        effectiveDiscount,
        effectivePremium,
        breakdown: {
          base: formatBps(config.baseFee),
          discount: `-${formatBps(effectiveDiscount)}`,
          premium: `+${formatBps(effectivePremium)}`,
          final: formatBps(fee),
        },
      } as DynamicFeeInfo;
    },
  });

  return {
    fee: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
