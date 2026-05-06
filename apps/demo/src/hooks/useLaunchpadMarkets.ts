import { useVisibleMarkets } from "./useVisibleMarkets";
import { useMemo } from "react";
import type { SQFRule } from "../lib/sqf";

export interface LaunchpadMarketData {
  address: `0x${string}`;
  name: string;
  question: string;
  symbol: string;
  outcomeToken?: `0x${string}`;
  bValue: bigint;
  creator: `0x${string}`;
  // Dynamic data
  isGraduated?: boolean;
  deadline?: number;
  liquidityB?: bigint;
  chainId?: number;
  // SQF fields
  event?: string;
  category?: string;
  ruleDescription?: string;
  rule?: SQFRule;
  metaPicture?: string;
  meta?: Record<string, string>;
}

/**
 * Legacy hook wrapper for V10 on-chain discovery.
 * Replaces the old LaunchpadFactory-based logic with LaunchpadEngine-based logic.
 */
export function useLaunchpadMarkets() {
  const {
    markets: onChainMarkets,
    isLoading,
    refetch,
    error,
  } = useVisibleMarkets();

  const markets: LaunchpadMarketData[] = useMemo(() => {
    return onChainMarkets.map((m) => ({
      address: m.address,
      name: m.name,
      question: m.question || m.name,
      symbol: m.symbol,
      creator: m.creator,
      isGraduated: m.isGraduated,
      bValue: m.bBase,
      liquidityB: m.bCurrent,
      chainId: undefined,
      deadline: 0,
      event: m.event,
      category: m.category,
      ruleDescription: m.ruleDescription,
      rule: m.rule,
      metaPicture: m.metaPicture,
      meta: m.meta,
    }));
  }, [onChainMarkets]);

  if (error) {
    console.error("useLaunchpadMarkets discovery error:", error);
  }

  return {
    markets,
    isLoading,
    refetch,
  };
}
