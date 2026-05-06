import { useReadContracts, useReadContract } from "@/lib/chain-shim";
import { useMemo } from "react";
import { ABIS, ERC20_ABI } from "../config/abis";
import { useChainStore } from "../store/useChainStore";
import { useDeployments } from "./useDeployments";
import { useAccount } from "@/lib/chain-shim";
import { getPollingInterval } from "../lib/polling";

/**
 * Hook to fetch creator's LP position and earnings for a market
 *
 * @param marketAddress - Address of the TruthMarket contract
 * @returns Creator position data including LP tokens, fees, and yield
 */
export function useCreatorPosition(marketAddress: `0x${string}` | undefined) {
  const { selectedChainId } = useChainStore();
  const chainId = selectedChainId ? Number(selectedChainId) : undefined;
  const { address: userAddress } = useAccount();
  const deployments = useDeployments();

  const launchpadEngineAddress = deployments?.contracts?.LaunchpadEngine as
    | `0x${string}`
    | undefined;
  const feeRouterAddress = deployments?.contracts?.FeeRouter as
    | `0x${string}`
    | undefined;

  const read = useReadContracts({
    contracts: [
      // Full market struct from mapping `markets(market)`
      {
        address: launchpadEngineAddress,
        abi: ABIS.LaunchpadEngine,
        functionName: "markets",
        args: marketAddress ? [marketAddress] : undefined,
        chainId,
      },
      // Graduation progress lives on FeeRouter in v0.1.2, not LaunchpadEngine.
      {
        address: feeRouterAddress,
        abi: ABIS.FeeRouter,
        functionName: "getGraduationProgress",
        args: marketAddress ? [marketAddress] : undefined,
        chainId,
      },
    ],
    query: {
      enabled:
        !!marketAddress &&
        !!launchpadEngineAddress &&
        !!feeRouterAddress &&
        !!userAddress &&
        !!selectedChainId,
      refetchInterval: getPollingInterval(chainId, "slow"),
      staleTime: 10000,
    },
  });

  const { data, isLoading, error, refetch } = read;

  const lpTokenAddress = useMemo(() => {
    const marketsResult = data?.[0];
    if (!marketsResult || marketsResult.status !== "success") return undefined;
    const marketState = marketsResult.result as readonly [
      `0x${string}`,
      `0x${string}`,
      bigint,
      bigint,
      bigint,
    ];
    const lpToken = marketState[1];
    if (lpToken === "0x0000000000000000000000000000000000000000")
      return undefined;
    return lpToken;
  }, [data]);

  const lpBalanceRead = useReadContract({
    address: lpTokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: userAddress ? [userAddress] : undefined,
    query: {
      enabled: !!lpTokenAddress && !!userAddress,
      refetchInterval: getPollingInterval(chainId, "slow"),
      staleTime: 10000,
    },
  });

  const creatorData = useMemo(() => {
    if (!data || !marketAddress || !userAddress) return null;

    const [marketsResult, graduationProgressResult] = data;

    // Check if critical reads failed
    if (
      marketsResult.status === "failure" ||
      graduationProgressResult.status === "failure"
    ) {
      return null;
    }

    // Parse markets(market) tuple:
    // (creator, lpToken, bBase, bCurrent, creatorDeposit, feesAccrued, totalLPSupply, lpYieldPool, isGraduated, createdAt, graduatedAt)
    const marketState = marketsResult.result as readonly [
      `0x${string}`,
      `0x${string}`,
      bigint,
      bigint,
      bigint,
    ];

    const [creator, _lpToken, bBase, creatorDeposit, graduatedAt] = marketState;
    // Fields no longer in markets() v0.1.2 — defaulted
    const bCurrent = bBase;
    const feesAccrued = 0n;
    const lpSupply = 0n;
    const lpYieldPool = 0n;
    const isGraduated = graduatedAt > 0n;
    const createdAt = 0n;

    const asBigInt = (v: unknown): bigint => {
      if (typeof v === "bigint") return v;
      if (typeof v === "number") return BigInt(v);
      if (typeof v === "string") return BigInt(v);
      return BigInt(v as any);
    };

    const lpSupplyBn = asBigInt(lpSupply);
    const lpYieldPoolBn = asBigInt(lpYieldPool);
    const feesAccruedBn = asBigInt(feesAccrued);
    const currentBBaseBn = asBigInt(bCurrent);
    const isGraduatedBool =
      typeof isGraduated === "boolean" ? isGraduated : Boolean(isGraduated);

    // Check if user is the creator
    const isCreator = creator.toLowerCase() === userAddress.toLowerCase();

    if (!isCreator) {
      return {
        address: marketAddress,
        isCreator: false,
        creator,
        lpBalance: 0n,
        lpShare: 0,
        feesAccrued: 0n,
        lpYieldPool: 0n,
        claimableYield: 0n,
        initialBBase: 0n,
        currentBBase: 0n,
        isGraduated: false,
      };
    }

    const lpBalance =
      typeof lpBalanceRead.data === "bigint" ? lpBalanceRead.data : 0n;

    const lpBalanceBn = asBigInt(lpBalance);

    // Calculate LP share (percentage of total supply)
    const lpShare =
      lpSupplyBn > 0n ? Number((lpBalanceBn * 10000n) / lpSupplyBn) / 100 : 0;

    // Calculate claimable yield (proportional to LP balance)
    const claimableYield =
      lpSupplyBn > 0n ? (lpYieldPoolBn * lpBalanceBn) / lpSupplyBn : 0n;

    // Calculate total earnings (fees + yield)
    const totalEarnings = feesAccruedBn + lpYieldPoolBn;

    // Calculate creator's share of fees (based on creatorFeeSplitBps, typically 50%)
    const estimatedCreatorFees = feesAccruedBn / 2n;

    return {
      address: marketAddress,
      isCreator: true,
      creator,
      lpBalance: lpBalanceBn,
      lpShare,
      lpSupply: lpSupplyBn,
      feesAccrued: feesAccruedBn,
      lpYieldPool: lpYieldPoolBn,
      claimableYield,
      totalEarnings,
      estimatedCreatorFees,
      initialBBase: asBigInt(bBase),
      currentBBase: currentBBaseBn,
      isGraduated: isGraduatedBool,
      creatorDeposit: asBigInt(creatorDeposit),
      createdAt: asBigInt(createdAt),
      graduatedAt: asBigInt(graduatedAt),
      // Helper flags
      hasLpTokens: lpBalanceBn > 0n,
      hasClaimableYield: claimableYield > 0n,
      hasEarnings: totalEarnings > 0n,
    };
  }, [data, lpBalanceRead.data, marketAddress, userAddress]);

  return {
    position: creatorData,
    isLoading,
    error,
    refetch,
  };
}

/**
 * Hook to check if user is creator of a market
 *
 * @param marketAddress - Address of the TruthMarket contract
 * @returns Boolean indicating if user is the creator
 */
export function useIsCreator(marketAddress: `0x${string}` | undefined) {
  const { address: userAddress } = useAccount();
  const { selectedChainId } = useChainStore();
  const chainId = selectedChainId ? Number(selectedChainId) : undefined;
  const deployments = useDeployments();

  const launchpadEngineAddress = deployments?.contracts?.LaunchpadEngine as
    | `0x${string}`
    | undefined;

  const { data, isLoading } = useReadContracts({
    contracts: [
      {
        address: launchpadEngineAddress,
        abi: ABIS.LaunchpadEngine,
        functionName: "markets",
        args: marketAddress ? [marketAddress] : undefined,
        chainId,
      },
    ],
    query: {
      enabled:
        !!marketAddress &&
        !!launchpadEngineAddress &&
        !!userAddress &&
        !!chainId,
      refetchInterval: false,
      staleTime: Infinity,
    },
  });

  const isCreator = useMemo(() => {
    if (!data || !userAddress) return false;

    const [marketStateResult] = data;

    if (marketStateResult.status === "failure") return false;

    const marketState = marketStateResult.result as readonly [
      `0x${string}`,
      `0x${string}`,
      bigint,
      bigint,
      bigint,
    ];
    const [creator] = marketState;

    return creator.toLowerCase() === userAddress.toLowerCase();
  }, [data, userAddress]);

  return {
    isCreator,
    isLoading,
  };
}

/**
 * Type definitions
 */
export type CreatorPositionData = NonNullable<
  ReturnType<typeof useCreatorPosition>["position"]
>;
