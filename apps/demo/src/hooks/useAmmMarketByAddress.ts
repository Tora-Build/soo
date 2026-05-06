import React from "react";
import { useReadContracts, useAccount, useReadContract } from "@/lib/chain-shim";
import { formatUnits } from "@/lib/chain-shim";
import {
  MARKET_V4_ABI,
  LAUNCHPAD_MARKET_ABI,
  LAUNCHPAD_OUTCOME_TOKEN_ABI,
} from "../config/abis";
import { useChainStore } from "../store/useChainStore";
import { Market } from "../types";
import * as polling from "../lib/polling";

export interface DynamicMarketData {
  address: `0x${string}`;
  name?: string;
  symbol?: string;
  isGraduated?: boolean;
  deadline?: number;
}

export function useAmmMarketByAddress(
  marketAddress?: `0x${string}`,
  marketMeta?: DynamicMarketData,
) {
  const { address: userAddress } = useAccount();
  const { selectedChainId } = useChainStore();
  const chainId = Number(selectedChainId);

  const { data: outcomeTokenAddr } = useReadContract({
    address: marketAddress,
    abi: LAUNCHPAD_MARKET_ABI,
    functionName: "outcomeToken",
    chainId: Number(selectedChainId),
    query: { enabled: !!marketAddress },
  });

  const {
    data: onChainData,
    refetch,
    isLoading,
  } = useReadContracts({
    contracts: [
      {
        address: marketAddress,
        abi: MARKET_V4_ABI,
        functionName: "isLive",
        chainId: Number(selectedChainId),
      },
      {
        address: marketAddress,
        abi: MARKET_V4_ABI,
        functionName: "isSettled",
        chainId: Number(selectedChainId),
      },
      {
        address: marketAddress,
        abi: MARKET_V4_ABI,
        functionName: "b",
        chainId: Number(selectedChainId),
      },
      {
        address: marketAddress,
        abi: MARKET_V4_ABI,
        functionName: "qYes",
        chainId: Number(selectedChainId),
      },
      {
        address: marketAddress,
        abi: MARKET_V4_ABI,
        functionName: "qNo",
        chainId: Number(selectedChainId),
      },
      {
        address: marketAddress,
        abi: MARKET_V4_ABI,
        functionName: "feeLMSR",
        chainId: Number(selectedChainId),
      },
      {
        address: outcomeTokenAddr as `0x${string}`,
        abi: LAUNCHPAD_OUTCOME_TOKEN_ABI,
        functionName: "balanceOf",
        args: [userAddress || "0x0000000000000000000000000000000000000000", 0n],
        chainId: Number(selectedChainId),
      },
      {
        address: outcomeTokenAddr as `0x${string}`,
        abi: LAUNCHPAD_OUTCOME_TOKEN_ABI,
        functionName: "balanceOf",
        args: [userAddress || "0x0000000000000000000000000000000000000000", 1n],
        chainId: Number(selectedChainId),
      },
    ],
    query: {
      enabled: !!marketAddress && !!outcomeTokenAddr,
      refetchInterval: polling.getPollingInterval(chainId, "fast"),
    },
  });

  const results = onChainData?.map((r) => r.result) || [];
  const [isLive, isSettled, bParam, qYes, qNo, feeData, walletYes, walletNo] =
    results;

  const walletYesShares = (walletYes as bigint) || 0n;
  const walletNoShares = (walletNo as bigint) || 0n;

  const market: Market | undefined = React.useMemo(() => {
    if (!marketAddress) return undefined;

    const qY = qYes ? Number(formatUnits(qYes as bigint, 18)) : 0;
    const qN = qNo ? Number(formatUnits(qNo as bigint, 18)) : 0;
    const b = bParam ? Number(formatUnits(bParam as bigint, 18)) : 1000;

    let calculatedPriceYes = 0.5;
    if (b > 0) {
      const maxQ = Math.max(qY, qN);
      const expY = Math.exp((qY - maxQ) / b);
      const expN = Math.exp((qN - maxQ) / b);
      calculatedPriceYes = expY / (expY + expN);
    }
    const calculatedPriceNo = 1 - calculatedPriceYes;

    const walletYesFloat = parseFloat(formatUnits(walletYesShares, 18));
    const walletNoFloat = parseFloat(formatUnits(walletNoShares, 18));

    return {
      id: marketAddress,
      id_numeric: 0,
      name: marketMeta?.name || "Launchpad Market",
      question:
        (marketMeta as any)?.question || marketMeta?.name || "Launchpad Market",
      description: `Symbol: ${marketMeta?.symbol || "N/A"}`,
      contractAddress: marketAddress,
      outcomeTokenAddress:
        (outcomeTokenAddr as `0x${string}`) ||
        "0x0000000000000000000000000000000000000000",
      chainId,
      mode: "real" as const,
      adjudicatorKind: "manual",
      openEnded: true,
      eventId: marketAddress,
      status: isSettled ? "settled" : isLive === false ? "cooldown" : "trading",
      priceYes: calculatedPriceYes,
      priceNo: calculatedPriceNo,
      qYes: (qYes as bigint) || 0n,
      qNo: (qNo as bigint) || 0n,
      bParam: (bParam as bigint) || 0n,
      userYesWallet: walletYesFloat,
      userNoWallet: walletNoFloat,
      userYesShares: 0,
      userNoShares: 0,
      userYesLocked: 0,
      userNoLocked: 0,
      userYesOutcomeTokens: walletYesFloat,
      userNoOutcomeTokens: walletNoFloat,
      userYesTotal: walletYesFloat,
      userNoTotal: walletNoFloat,
      unlockTime: 0,
      userAvgEntryYes: null,
      userAvgEntryNo: null,
      fee: feeData ? Number(feeData) / 10000 : 0.005,
      adjudicatorId: "N/A",
      adjudicatorLabel: "Manual",
      isLaunchpad: true,
      isGraduated: marketMeta?.isGraduated || false,
      deadline: marketMeta?.deadline,
    } as Market;
  }, [
    marketAddress,
    marketMeta,
    isSettled,
    isLive,
    bParam,
    qYes,
    qNo,
    feeData,
    outcomeTokenAddr,
    walletYesShares,
    walletNoShares,
    chainId,
  ]);

  return {
    market,
    isLoading: isLoading || !onChainData,
    refetch,
  };
}
