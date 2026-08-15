import {
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
} from "@/lib/chain-shim";
import { useMemo, useCallback, useEffect } from "react";
import { ABIS, ERC20_ABI } from "../config/abis";
import { useChainStore } from "../store/useChainStore";
import { useDeployments } from "./useDeployments";
import { useAccount } from "@/lib/chain-shim";
import { maxUint256 } from "@/lib/chain-shim";
import { getPollingInterval } from "../lib/polling";
import { shortenAddress } from "../utils/format";

/**
 * Hook to fetch LaunchpadEngine state for a market and handle market operations
 *
 * @param marketAddress - Address of the TruthMarket contract
 * @returns LaunchpadEngine data and write functions
 */
export function useLaunchpadMarket(marketAddress?: `0x${string}`) {
  const { selectedChainId } = useChainStore();
  const { address: userAddress } = useAccount();
  const deployments = useDeployments();
  const chainId =
    typeof selectedChainId === "number"
      ? selectedChainId
      : Number(selectedChainId);

  const launchpadEngineAddress = deployments?.contracts?.LaunchpadEngine as
    | `0x${string}`
    | undefined;
  const feeRouterAddress = deployments?.contracts?.FeeRouter as
    | `0x${string}`
    | undefined;
  const ammEngineAddress = deployments?.contracts?.AMMEngine as
    | `0x${string}`
    | undefined;
  const usdcAddress = deployments?.contracts?.MockUSDC as
    | `0x${string}`
    | undefined;

  // Writes
  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
    error: writeError,
  } = useWriteContract();
  const {
    writeContract: writeApprove,
    data: approveTxHash,
    isPending: isApproveWritePending,
  } = useWriteContract();

  // Transaction Status
  const {
    isLoading: isConfirming,
    isSuccess: isConfirmed,
    data: receipt,
  } = useWaitForTransactionReceipt({
    hash: txHash,
  });
  const { isLoading: isApproveConfirming, isSuccess: isApproveConfirmed } =
    useWaitForTransactionReceipt({
      hash: approveTxHash,
    });

  const isPending = isWritePending || isConfirming;
  const isApprovePending = isApproveWritePending || isApproveConfirming;

  // USDC Allowance & Balance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args:
      userAddress && launchpadEngineAddress
        ? [userAddress, launchpadEngineAddress]
        : undefined,
    query: {
      enabled: !!userAddress && !!launchpadEngineAddress && !!usdcAddress,
    },
  });

  const { data: usdcBalance } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: userAddress ? [userAddress] : undefined,
    query: { enabled: !!userAddress && !!usdcAddress },
  });

  // protocolConfig removed in v0.1.2
  const protocolConfig = undefined;

  // Market reads (lightweight mapping state + graduation).
  // Indices kept for downstream consumers — slot 0 and slots 3/4 are now
  // stubs since getMarketState / trialStates / userLockedCost don't exist
  // on v0.1.2 LaunchpadEngine. getGraduationProgress now lives on FeeRouter
  // (see BUG-003). Slot 1 still hits LaunchpadEngine.markets().
  const readMarket = useReadContracts({
    contracts: [
      // Slot 0: placeholder (was getMarketState). We pin to a cheap no-arg
      // view on LaunchpadEngine so the call succeeds and the index stays
      // stable, but its result is ignored downstream.
      {
        address: launchpadEngineAddress,
        abi: ABIS.LaunchpadEngine,
        functionName: "getMarketCount",
        chainId,
      },
      {
        address: launchpadEngineAddress,
        abi: ABIS.LaunchpadEngine,
        functionName: "markets",
        args: marketAddress ? [marketAddress] : undefined,
        chainId,
      },
      // Slot 2: graduation progress — routed to FeeRouter.
      {
        address: feeRouterAddress,
        abi: ABIS.FeeRouter,
        functionName: "getGraduationProgress",
        args: marketAddress ? [marketAddress] : undefined,
        chainId,
      },
      // Slot 3: trialEndTimes — the composite trialStates() was removed
      // but the individual trialEndTimes(address) getter still exists.
      {
        address: launchpadEngineAddress,
        abi: ABIS.LaunchpadEngine,
        functionName: "trialEndTimes",
        args: marketAddress ? [marketAddress] : undefined,
        chainId,
      },
      // Slot 4: userLockedCost removed (dismiss feature gone). Placeholder.
      {
        address: launchpadEngineAddress,
        abi: ABIS.LaunchpadEngine,
        functionName: "getMarketCount",
        chainId,
      },
    ],
    query: {
      enabled: !!marketAddress && !!launchpadEngineAddress && !!selectedChainId,
      refetchInterval: getPollingInterval(chainId, "slow"),
      staleTime: 10000,
    },
  });

  const lpTokenAddress = useMemo(() => {
    const marketsMappingResult = (readMarket.data as any[] | undefined)?.[1];
    if (marketsMappingResult?.status !== "success") return undefined;
    const marketState = marketsMappingResult.result as readonly [
      `0x${string}`, // creator
      `0x${string}`, // lpToken
      bigint, // bBase
      bigint, // bCurrent
      bigint, // creatorDeposit
      bigint, // feesAccrued
      bigint, // totalLPSupply
      bigint, // lpYieldPool
      boolean, // isGraduated
      bigint, // createdAt
      bigint, // graduatedAt
    ];
    const lpToken = marketState[1];
    if (lpToken === "0x0000000000000000000000000000000000000000")
      return undefined;
    return lpToken;
  }, [readMarket.data]);

  // LP Balance (separate optional read)
  const readLpBalance = useReadContract({
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

  // Fee bps live on FeeRouter, NOT LaunchpadEngine (see BUG-003).
  // graduationMultiplier was removed in v0.1.2 — fallback to 1x downstream.
  const readParams = useReadContracts({
    contracts: [
      {
        address: feeRouterAddress,
        abi: ABIS.FeeRouter,
        functionName: "preGradFeeBps",
        chainId,
      },
      {
        address: feeRouterAddress,
        abi: ABIS.FeeRouter,
        functionName: "postGradFeeBps",
        chainId,
      },
      {
        address: feeRouterAddress,
        abi: ABIS.FeeRouter,
        functionName: "lpYieldShareBps",
        chainId,
      },
    ],
    query: {
      enabled: !!feeRouterAddress && !!selectedChainId,
      refetchInterval: false,
      staleTime: Infinity,
    },
  });

  const dataMarket = readMarket.data;
  const dataParams = readParams.data;
  const dataLpBalance = readLpBalance.data;
  const isLoading = readMarket.isLoading;
  const error = readMarket.error || readParams.error;

  const refetch = useCallback(async () => {
    await Promise.all([
      readMarket.refetch(),
      readParams.refetch(),
      readLpBalance.refetch(),
      refetchAllowance(),
    ]);
  }, [readMarket, readParams, readLpBalance, refetchAllowance]);

  useEffect(() => {
    if (isConfirmed || isApproveConfirmed) refetch();
  }, [isConfirmed, isApproveConfirmed, refetch]);

  // -------------------------------------------------------------------------
  // WRITE FUNCTIONS
  // -------------------------------------------------------------------------

  const createMarket = useCallback(
    (
      question: string,
      startTime: bigint,
      deadline: bigint,
      adjudicator: `0x${string}`,
      initialLiquidity: bigint,
      adjudicatorAgentId: bigint = 0n,
      adjudicatorMinValidators: bigint = 0n,
    ) => {
      // NOTE: This hook is stale (v0.1.2 createMarket signature changed).
      // Production code uses Launchpad.tsx directly.
      if (!launchpadEngineAddress) return;
      void question; void startTime; void deadline; void adjudicator; void initialLiquidity; void adjudicatorAgentId; void adjudicatorMinValidators;
    },
    [launchpadEngineAddress],
  );

  const approveUSDC = useCallback(() => {
    if (!usdcAddress || !launchpadEngineAddress) return;
    writeApprove({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [launchpadEngineAddress, maxUint256],
    });
  }, [usdcAddress, launchpadEngineAddress, writeApprove]);

  // redeemLP lives on AMMEngine in v0.1.2, not LaunchpadEngine.
  const redeemLP = useCallback(
    (amount: bigint) => {
      if (!ammEngineAddress || !marketAddress) return;
      writeContract({
        address: ammEngineAddress,
        abi: ABIS.AMMEngine,
        functionName: "redeemLP",
        args: [marketAddress, amount],
      });
    },
    [ammEngineAddress, marketAddress, writeContract],
  );

  // The deployed v0.1.2 LaunchpadEngine has no trial / dismiss / refund
  // functions. These write actions stay as no-ops so consumers can mount
  // conditionally without crashing.
  const dismissMarket = useCallback(() => {}, []);
  const claimRefund = useCallback(() => {}, []);

  const launchpadData = useMemo(() => {
    if (!dataMarket || !marketAddress) return null;

    const marketResults = dataMarket as any[];
    // Slot 0 / 3 / 4 are placeholders (see readMarket comment) — v0.1.2
    // LaunchpadEngine exposes no getMarketState / trialStates /
    // userLockedCost.
    const marketsMappingResult = marketResults[1];
    const graduationProgressResult = marketResults[2];
    const lpBalanceResult = dataLpBalance;

    const preGradFeeResult = (dataParams as any[] | undefined)?.[0];
    const postGradFeeResult = (dataParams as any[] | undefined)?.[1];
    const lpYieldShareBpsResult = (dataParams as any[] | undefined)?.[2];

    // Check if critical reads failed
    if (
      marketsMappingResult?.status === "failure" ||
      graduationProgressResult?.status === "failure"
    ) {
      return null;
    }

    // floorValue computation was tied to the old getMarketState view —
    // leave zero until a replacement view lands on-chain.
    const bCurrent = 0n;
    const totalLPSupply = 0n;
    const floorValue = 0n;

    // markets(market) returns 5 fields in v0.1.2
    const marketState = marketsMappingResult.result as readonly [
      `0x${string}`, // creator
      `0x${string}`, // lpToken
      bigint, // bBase
      bigint, // creatorDeposit
      bigint, // graduatedAt (uint64)
    ];
    const [creator, _lpToken, bBase, creatorDeposit, graduatedAtBig] =
      marketState;
    const feesAccruedFromMarket = 0n;
    const isGraduated = graduatedAtBig > 0n;
    void _lpToken;

    // V10.8.3: Symbol fallback derived from market address.
    const symbol = shortenAddress(marketAddress);
    const name = symbol;

    // getGraduationProgress(market) -> (feesAccrued, threshold, progressBps)
    const graduationProgressTuple =
      graduationProgressResult.result as readonly [bigint, bigint, bigint];
    const [feesAccrued, graduationThreshold, progressBps] =
      graduationProgressTuple;

    // Trial period is still on-chain (trialEndTimes getter). Dismiss/refund
    // functions are removed — isDismissed is always false.
    const trialEndTimeResult = marketResults[3];
    const trialEndTime =
      trialEndTimeResult?.status === "success"
        ? (trialEndTimeResult.result as bigint)
        : 0n;
    const isDismissed = false;
    const totalLockedCost = 0n;
    const userLockedCostValue = 0n;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const isInTrialPeriod =
      trialEndTime > 0n && now < trialEndTime && !isGraduated;
    const trialEnded = trialEndTime > 0n && now >= trialEndTime;
    const canDismiss = false; // dismiss removed in v0.1.2
    const canClaimRefund = false;
    const trialTimeRemaining =
      trialEndTime > now ? Number(trialEndTime - now) : 0;

    const userLpBalance =
      typeof lpBalanceResult === "bigint" ? lpBalanceResult : 0n;
    const preGradFeeBps =
      preGradFeeResult?.status === "success"
        ? (preGradFeeResult.result as bigint)
        : 500n; // Default 5%
    const postGradFeeBps =
      postGradFeeResult?.status === "success"
        ? (postGradFeeResult.result as bigint)
        : 100n; // Default 1%
    const lpYieldShareBps =
      lpYieldShareBpsResult?.status === "success"
        ? (lpYieldShareBpsResult.result as bigint)
        : 3000n; // Default 30%
    // graduationMultiplier was removed in v0.1.2 — keep field for UI compat.
    const graduationMultiplier = 1n;

    // progressBps is already 0-10000
    const graduationProgress = Number(progressBps) / 100;

    // Current fee rate
    const currentFeeBps = isGraduated ? postGradFeeBps : preGradFeeBps;

    // Compute lpYieldPool: post-graduation fees × lpYieldShareBps / 10000
    // Post-grad fees = feesAccrued - graduationThreshold (only when graduated)
    const yieldBps = BigInt(lpYieldShareBps ?? 3000n);
    const lpYieldPoolWad = isGraduated && feesAccrued > graduationThreshold
      ? ((feesAccrued - graduationThreshold) * yieldBps) / 10000n
      : 0n;
    // WAD to USDC: divide by 1e12 (1e18 / 1e6)
    const lpYieldPool = lpYieldPoolWad / 1_000_000_000_000n;

    return {
      address: marketAddress,
      creator,
      name,
      symbol,
      initialBBase: bBase,
      currentBBase: bCurrent,
      feesAccrued: feesAccrued ?? feesAccruedFromMarket,
      lpSupply: totalLPSupply,
      floorValue,
      lpYieldPool,
      creatorDeposit,
      isGraduated,
      graduationThreshold,
      graduationProgress: Math.min(100, graduationProgress),
      userLpBalance,
      preGradFeeBps,
      postGradFeeBps,
      currentFeeBps,
      graduationMultiplier,
      // Helper flags
      canGraduate: progressBps >= 10000n && !isGraduated,
      hasLpTokens: userLpBalance > 0n,
      hasAccruedFees: (feesAccrued ?? feesAccruedFromMarket) > 0n,
      // V11: Trial period data
      trialEndTime: Number(trialEndTime),
      isDismissed,
      totalLockedCost,
      userLockedCost: userLockedCostValue,
      isInTrialPeriod,
      trialEnded,
      canDismiss,
      canClaimRefund,
      trialTimeRemaining,
    };
  }, [dataMarket, dataParams, dataLpBalance, marketAddress]);

  return {
    launchpad: launchpadData,
    isLoading,
    error,
    refetch,
    createMarket,
    approveUSDC,
    redeemLP,
    // V11: Trial period actions
    dismissMarket,
    claimRefund,
    isPending,
    isApprovePending,
    isConfirmed,
    txHash,
    writeError,
    allowance,
    usdcBalance,
    deployedMarketAddress: marketAddress,
  };
}

/**
 * Type definition for LaunchpadMarket data
 */
export type LaunchpadMarketData = NonNullable<
  ReturnType<typeof useLaunchpadMarket>["launchpad"]
>;
