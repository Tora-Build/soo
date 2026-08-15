import { lookupMarketQuestion } from "../lib/market-questions";
import { useChainStore } from "../store/useChainStore";
import { useDeployments, getAllDeploymentsForChain } from "./useDeployments";
import { ABIS, ERC20_ABI } from "../config/abis";
import { useDirectRead, readContractSafe } from "./useDirectRead";
import { useCallback } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "@/lib/chain-shim";
import { shortenAddress } from "../utils/format";

type Address = `0x${string}`;

import { useAccount } from "@/lib/chain-shim";

/**
 * Hook to read Launchpad market state (V9 Architecture)
 */
export function useLaunchpadMarketDirect(marketAddress: Address | undefined) {
  const { selectedChainId } = useChainStore();
  const { address: userAddress } = useAccount();
  const chainId =
    typeof selectedChainId === "number"
      ? selectedChainId
      : Number(selectedChainId);
  const deployments = useDeployments();
  const launchpadEngineAddress = deployments?.contracts?.LaunchpadEngine as
    | Address
    | undefined;
  const feeRouterAddress = deployments?.contracts?.FeeRouter as
    | Address
    | undefined;
  const ammEngineAddress = deployments?.contracts?.AMMEngine as
    | Address
    | undefined;
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

  // V11: Write functions for dismiss and claim refund
  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
  } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });
  const isPending = isWritePending || isConfirming;

  const dismissMarket = useCallback(() => {
    if (!launchpadEngineAddress || !marketAddress) return;
    writeContract({
      address: launchpadEngineAddress,
      abi: ABIS.LaunchpadEngine,
      functionName: "dismissMarket",
      args: [marketAddress],
    });
  }, [launchpadEngineAddress, marketAddress, writeContract]);

  const claimRefund = useCallback(() => {
    if (!launchpadEngineAddress || !marketAddress) return;
    writeContract({
      address: launchpadEngineAddress,
      abi: ABIS.LaunchpadEngine,
      functionName: "claimRefund",
      args: [marketAddress],
    });
  }, [launchpadEngineAddress, marketAddress, writeContract]);

  const query = useDirectRead({
    queryKey: [
      "v9",
      "launchpadMarketDirect",
      chainId,
      launchpadEngineAddress,
      marketAddress,
      userAddress,
    ],
    enabled: !!marketAddress && !!chainId && !!launchpadEngineAddress,
    chainId,
    read: async (client) => {
      // Multi-node-per-chain: a single chainId can host multiple
      // LaunchpadEngines (e.g. Base Sepolia v0.2.0 + v0.1.2). The default
      // useDeployments() returns the first match (currently v0.2.0), but
      // the market the user is viewing may live on the *other* engine.
      // Probe every deployment for the chain and pick the one that knows
      // this market (creator !== ZERO).
      const candidates = getAllDeploymentsForChain(chainId);
      const orderedEngines = (() => {
        const seen = new Set<string>();
        const list: { contracts: Record<string, string | number> }[] = [];
        // Always try the currently-selected deployment first.
        if (launchpadEngineAddress) {
          const primary = candidates.find(
            (c) =>
              (
                c.contracts.LaunchpadEngine as string | undefined
              )?.toLowerCase() === launchpadEngineAddress.toLowerCase(),
          );
          if (primary) {
            seen.add((primary.contracts.LaunchpadEngine as string).toLowerCase());
            list.push(primary);
          }
        }
        for (const c of candidates) {
          const addr = (
            c.contracts.LaunchpadEngine as string | undefined
          )?.toLowerCase();
          if (addr && !seen.has(addr)) {
            seen.add(addr);
            list.push(c);
          }
        }
        return list;
      })();

      let resolvedDeployment: { contracts: Record<string, string | number> } | undefined;
      let marketsMapping:
        | readonly [Address, Address, bigint, bigint, bigint]
        | undefined;
      for (const dep of orderedEngines) {
        const engine = dep.contracts.LaunchpadEngine as Address | undefined;
        if (!engine) continue;
        try {
          const result = (await readContractSafe<
            readonly [Address, Address, bigint, bigint, bigint]
          >(client, {
            address: engine,
            abi: ABIS.LaunchpadEngine,
            functionName: "markets",
            args: [marketAddress!],
          })) as readonly [Address, Address, bigint, bigint, bigint];
          if (result && result[0] !== ZERO_ADDRESS) {
            marketsMapping = result;
            resolvedDeployment = dep;
            break;
          }
          // Keep the first non-zero-engine reading as a fallback so we
          // still surface "creator=0" instead of crashing if no engine
          // owns the market.
          if (!marketsMapping) {
            marketsMapping = result;
            resolvedDeployment = dep;
          }
        } catch {
          // engine doesn't expose markets() in the expected shape — skip
        }
      }

      if (!marketsMapping) {
        marketsMapping = [
          ZERO_ADDRESS as Address,
          ZERO_ADDRESS as Address,
          0n,
          0n,
          0n,
        ];
      }

      // Use the resolved deployment's other contracts (FeeRouter,
      // AMMEngine) so subsequent reads are consistent with the engine
      // that actually owns the market.
      const resolvedFeeRouter = (resolvedDeployment?.contracts.FeeRouter ??
        feeRouterAddress) as Address | undefined;
      const resolvedAmmEngine = (resolvedDeployment?.contracts.AMMEngine ??
        ammEngineAddress) as Address | undefined;

      const [creator, lpToken, bBase, creatorDeposit, graduatedAt] =
        marketsMapping;

      // Fetch live bCurrent from AMMEngine.getLiquidity(market)
      let bCurrent = bBase;
      if (resolvedAmmEngine) {
        try {
          const live = await readContractSafe<bigint>(client, {
            address: resolvedAmmEngine,
            abi: ABIS.AMMEngine,
            functionName: "getLiquidity",
            args: [marketAddress!],
          });
          if (live && live > 0n) bCurrent = live;
        } catch {
          // fallback to bBase
        }
      }

      // Fetch LP token total supply
      let totalLPSupply = 0n;
      if (lpToken && lpToken !== "0x0000000000000000000000000000000000000000") {
        try {
          const supply = await readContractSafe<bigint>(client, {
            address: lpToken as Address,
            abi: ERC20_ABI,
            functionName: "totalSupply",
          });
          if (supply) totalLPSupply = supply;
        } catch {
          // fallback to 0n
        }
      }

      const feesAccruedFromMarket = 0n;
      const isGraduated = graduatedAt > 0n;
      const createdAt = 0n;

      const marketSymbol = shortenAddress(marketAddress!);
      // The market's question, not its address.
      //
      // `Market` stores only `question_hash`; the text is emitted in
      // `MarketCreated` and cached locally once recovered, so this is a cheap
      // read of what the list already resolved. Falls back to the shortened
      // address for markets created before the event carried the question —
      // those genuinely have no recoverable title.
      const marketName =
        lookupMarketQuestion(marketAddress) || marketSymbol;

      // Fee bps + graduation progress live on FeeRouter, NOT LaunchpadEngine
      // (see BUG-003). Calling them on LaunchpadEngine reverts and wastes
      // RPC calls; route to FeeRouter.
      const [preGradFeeBps, postGradFeeBps, lpYieldShareBps] = resolvedFeeRouter
        ? await Promise.all([
            readContractSafe<bigint>(client, {
              address: resolvedFeeRouter,
              abi: ABIS.FeeRouter,
              functionName: "preGradFeeBps",
            }).catch(() => 500n),
            readContractSafe<bigint>(client, {
              address: resolvedFeeRouter,
              abi: ABIS.FeeRouter,
              functionName: "postGradFeeBps",
            }).catch(() => 100n),
            readContractSafe<bigint>(client, {
              address: resolvedFeeRouter,
              abi: ABIS.FeeRouter,
              functionName: "lpYieldShareBps",
            }).catch(() => 3000n),
          ])
        : [500n, 100n, 3000n];
      // v0.1.2 exposes no graduationMultiplier; keep the shape but treat it
      // as 1x for display purposes.
      const graduationMultiplier = 1n;

      const isCreated = creator !== ZERO_ADDRESS;

      const [feesAccrued, graduationThreshold, progressBps] = resolvedFeeRouter
        ? await readContractSafe<readonly [bigint, bigint, bigint]>(client, {
            address: resolvedFeeRouter,
            abi: ABIS.FeeRouter,
            functionName: "getGraduationProgress",
            args: [marketAddress!],
          }).catch(() => [0n, 0n, 0n] as const)
        : ([0n, 0n, 0n] as const);

      // Calculate effective graduation (handling stale RPC data)
      const isEffectiveGraduated =
        isGraduated || (!!progressBps && progressBps >= 10000n);
      const currentFeeBps = isEffectiveGraduated
        ? postGradFeeBps
        : preGradFeeBps;

      // Compute lpYieldPool: post-graduation fees x lpYieldShareBps / 10000
      // feesAccrued and graduationThreshold are in WAD (1e18).
      // Convert result to USDC decimals for display consistency.
      const yieldBps = BigInt(lpYieldShareBps ?? 3000);
      const lpYieldPoolWad =
        isEffectiveGraduated && feesAccrued > graduationThreshold
          ? ((feesAccrued - graduationThreshold) * yieldBps) / 10000n
          : 0n;
      // WAD → USDC: divide by 1e12 (1e18 / 1e6)
      const lpYieldPool = lpYieldPoolWad / 1_000_000_000_000n;

      const userLpBalance =
        userAddress && lpToken !== ZERO_ADDRESS
          ? await readContractSafe<bigint>(client, {
              address: lpToken,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [userAddress],
            })
          : 0n;

      // LaunchpadEngine.getMarketState(address) does not exist in v0.1.2, and
      // floorValue needs the bonding-curve LP state it would expose; leave as
      // 0 until a replacement view is deployed.
      const floorValue = 0n;

      const graduationProgressPct = Math.min(100, Number(progressBps) / 100);

      // Trial period is still active in v0.1.2. The composite
      // trialStates() getter was removed but trialEndTimes(address)
      // exists. Dismiss/refund functions are gone — isDismissed is
      // always false.
      let trialEndTime = 0n;
      try {
        trialEndTime = await readContractSafe<bigint>(client, {
          address: launchpadEngineAddress!,
          abi: ABIS.LaunchpadEngine,
          functionName: "trialEndTimes",
          args: [marketAddress!],
        });
      } catch {
        // trialEndTimes may not exist on older deploys
      }
      const isDismissed = false;
      const totalLockedCost = 0n;
      const userLockedCost = 0n;

      // V11: Calculate trial period status
      const now = BigInt(Math.floor(Date.now() / 1000));
      const isInTrialPeriod =
        trialEndTime > 0n && now < trialEndTime && !isDismissed;
      const trialEnded = trialEndTime > 0n && now >= trialEndTime;
      const canDismiss = trialEnded && !isDismissed && !isEffectiveGraduated;
      const canClaimRefund = isDismissed && userLockedCost > 0n;
      const trialTimeRemaining =
        trialEndTime > now ? Number(trialEndTime - now) : 0;

      return {
        address: marketAddress!,
        isCreated,
        creator,
        lpToken,
        initialBBase: bBase,
        currentBBase: bCurrent,
        creatorDeposit,
        feesAccrued: feesAccrued ?? feesAccruedFromMarket,
        lpSupply: totalLPSupply,
        lpYieldPool,
        isGraduated: isEffectiveGraduated,
        createdAt,
        graduatedAt,
        name: marketName,
        symbol: marketSymbol,
        floorValue,
        graduationThreshold,
        graduationProgress: graduationProgressPct,
        userLpBalance: userLpBalance ?? 0n,
        preGradFeeBps,
        postGradFeeBps,
        currentFeeBps,
        graduationMultiplier,
        canGraduate:
          (progressBps ? progressBps >= 10000n : false) &&
          !isEffectiveGraduated,
        hasLpTokens: (userLpBalance ?? 0n) > 0n,
        hasAccruedFees: (feesAccrued ?? feesAccruedFromMarket) > 0n,
        // V11: Trial period data
        trialEndTime: Number(trialEndTime),
        isDismissed,
        totalLockedCost,
        userLockedCost,
        isInTrialPeriod,
        trialEnded,
        canDismiss,
        canClaimRefund,
        trialTimeRemaining,
      };
    },
  });

  return {
    launchpad: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    // V11: Trial period actions
    dismissMarket,
    claimRefund,
    isPending,
    isConfirmed,
    txHash,
  };
}
