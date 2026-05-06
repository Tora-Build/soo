import { useAccount, useReadContracts, useChainId } from "@/lib/chain-shim";
import { useMemo } from "react";
import { formatUnits } from "@/lib/chain-shim";
import { LAUNCHPAD_MARKET_ABI } from "../config/abis";
import { useLaunchpadMarkets } from "./useLaunchpadMarkets";
import { getPollingInterval } from "../lib/polling";

export interface LPPosition {
  marketAddress: `0x${string}`;
  question: string;
  lpBalance: bigint;
  lpBalanceFormatted: string;
  ceilingValue: bigint;
  ceilingValueFormatted: string;
  floorValue: bigint;
  floorValueFormatted: string;
  totalSupply: bigint;
  sharePercent: number;
  totalAssets: bigint;
  totalNetAssets: bigint;
  isGraduated: boolean;
  isLive: boolean;
}

export function useLPPositions() {
  const chainId = useChainId();
  const { address: userAddress } = useAccount();
  const { markets, isLoading: marketsLoading } = useLaunchpadMarkets();

  // Build contract calls for all markets
  const lpContracts = useMemo(() => {
    if (!markets?.length || !userAddress) return [];

    return markets.flatMap((market) => [
      // LP balance
      {
        address: market.address,
        abi: LAUNCHPAD_MARKET_ABI,
        functionName: "balanceOf" as const,
        args: [userAddress],
      },
      // Total supply
      {
        address: market.address,
        abi: LAUNCHPAD_MARKET_ABI,
        functionName: "totalSupply" as const,
      },
      // Total assets (Gross TVL)
      {
        address: market.address,
        abi: LAUNCHPAD_MARKET_ABI,
        functionName: "totalAssets" as const,
      },
      // Net assets (Floor TVL)
      {
        address: market.address,
        abi: LAUNCHPAD_MARKET_ABI,
        functionName: "totalNetAssets" as const,
      },
      // isLive
      {
        address: market.address,
        abi: LAUNCHPAD_MARKET_ABI,
        functionName: "isLive" as const,
      },
      // Pure AMM Accounting (V6.1.9)
      {
        address: market.address,
        abi: LAUNCHPAD_MARKET_ABI,
        functionName: "ammAssets" as const,
      },
      {
        address: market.address,
        abi: LAUNCHPAD_MARKET_ABI,
        functionName: "totalNetAssets" as const,
      },
      {
        address: market.address,
        abi: LAUNCHPAD_MARKET_ABI,
        functionName: "pureCeilingAssets" as const,
      },
    ]);
  }, [markets, userAddress]);

  const {
    data: lpData,
    isLoading: lpDataLoading,
    refetch,
  } = useReadContracts({
    contracts: lpContracts,
    query: {
      enabled: lpContracts.length > 0,
      refetchInterval: getPollingInterval(chainId, "slow"),
      staleTime: 10000,
    },
  });

  // LP tokens are 18 decimals (ERC20), USDC values are 6 decimals
  const LP_TOKEN_DECIMALS = 18;
  const USDC_DECIMALS = 6;

  // Process LP positions
  const positions: LPPosition[] = useMemo(() => {
    if (!markets?.length || !lpData) return [];

    return markets
      .map((market, i) => {
        const baseIdx = i * 8; // 8 contract calls per market
        const lpBalance = (lpData[baseIdx]?.result as bigint) || 0n;
        const totalSupply = (lpData[baseIdx + 1]?.result as bigint) || 0n;
        const totalAssets = (lpData[baseIdx + 2]?.result as bigint) || 0n;
        const totalNetAssets = (lpData[baseIdx + 3]?.result as bigint) || 0n;
        const isLive = lpData[baseIdx + 4]?.result as boolean;

        // On-Chain Pure Ledger (V6.1.9)
        const ammCash = (lpData[baseIdx + 5]?.result as bigint) || 0n;
        const floorTVL = (lpData[baseIdx + 6]?.result as bigint) || 0n;
        const ceilingTVL = (lpData[baseIdx + 7]?.result as bigint) || 0n;

        const floorValue =
          totalSupply > 0n ? (lpBalance * floorTVL) / totalSupply : 0n;

        const ceilingValue =
          totalSupply > 0n ? (lpBalance * ceilingTVL) / totalSupply : 0n;

        // Calculate share percent
        const sharePercent =
          totalSupply > 0n
            ? Number((lpBalance * 10000n) / totalSupply) / 100
            : 0;

        return {
          marketAddress: market.address,
          question: market.question || market.name || "Unknown Market",
          lpBalance,
          lpBalanceFormatted: formatUnits(lpBalance, LP_TOKEN_DECIMALS),
          ceilingValue,
          ceilingValueFormatted: formatUnits(ceilingValue, USDC_DECIMALS),
          floorValue,
          floorValueFormatted: formatUnits(floorValue, USDC_DECIMALS),
          // Legacy support
          estimatedValue: floorValue,
          estimatedValueFormatted: formatUnits(floorValue, USDC_DECIMALS),
          totalSupply,
          sharePercent,
          totalAssets,
          totalNetAssets,
          isGraduated: market.isGraduated || false,
          isLive: !!isLive,
        };
      })
      .filter((p) => p.lpBalance > 0n); // Only show positions with LP tokens
  }, [markets, lpData]);

  // Total LP value across all markets (Using Floor Value for total)
  const totalLPValue = useMemo(() => {
    return positions.reduce((acc, p) => acc + p.floorValue, 0n);
  }, [positions]);

  // Total Ceiling value
  const totalCeilingValue = useMemo(() => {
    return positions.reduce((acc, p) => acc + p.ceilingValue, 0n);
  }, [positions]);

  const totalLPValueFormatted = formatUnits(totalLPValue, USDC_DECIMALS);
  const totalCeilingValueFormatted = formatUnits(
    totalCeilingValue,
    USDC_DECIMALS,
  );

  return {
    positions,
    totalLPValue,
    totalLPValueFormatted,
    totalCeilingValue,
    totalCeilingValueFormatted,
    isLoading: marketsLoading || lpDataLoading,
    refetch,
  };
}
