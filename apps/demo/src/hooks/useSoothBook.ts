import { useReadContract } from "@/lib/chain-shim";
import type { Address } from "@/lib/chain-shim";
import { SOOTHBOOK_ABI } from "../config/abis";

export interface SoothBookMarketState {
  collateral?: Address;
  yesToken?: Address;
  noToken?: Address;
  isActive: boolean;
  isFinalized: boolean;
  outcome: number;
}

export interface SoothBookPrices {
  yesPrice?: bigint;
  noPrice?: bigint;
  bestYesTick?: number;
  bestNoTick?: number;
}

export function useSoothBookMarket(soothBookAddress?: Address, marketKey?: `0x${string}`) {
  const canRead = !!soothBookAddress && !!marketKey;

  const { data: isRegistered, isLoading: isMarketLoading } = useReadContract({
    address: soothBookAddress,
    abi: SOOTHBOOK_ABI,
    functionName: "registeredMarkets",
    args: marketKey ? [marketKey] : undefined,
    query: { enabled: canRead },
  });

  const { data: backing } = useReadContract({
    address: soothBookAddress,
    abi: SOOTHBOOK_ABI,
    functionName: "getCollateralBacking",
    args: marketKey ? [marketKey] : undefined,
    query: { enabled: canRead },
  });

  const { data: bestYesTick } = useReadContract({
    address: soothBookAddress,
    abi: SOOTHBOOK_ABI,
    functionName: "getBestTick",
    args: marketKey ? [marketKey, 1] : undefined,
    query: { enabled: canRead, refetchInterval: 10_000 },
  });

  const { data: bestNoTick } = useReadContract({
    address: soothBookAddress,
    abi: SOOTHBOOK_ABI,
    functionName: "getBestTick",
    args: marketKey ? [marketKey, 0] : undefined,
    query: { enabled: canRead, refetchInterval: 10_000 },
  });

  const { data: implied } = useReadContract({
    address: soothBookAddress,
    abi: SOOTHBOOK_ABI,
    functionName: "getImpliedPriceByKey",
    args: marketKey ? [marketKey] : undefined,
    query: { enabled: canRead, refetchInterval: 10_000 },
  });

  const marketState: SoothBookMarketState = {
    collateral: undefined,
    yesToken: undefined,
    noToken: undefined,
    isActive: Boolean(isRegistered),
    isFinalized: false,
    outcome: 0,
  };

  const prices: SoothBookPrices = {
    yesPrice: implied?.[0] as bigint | undefined,
    noPrice: implied?.[1] as bigint | undefined,
    bestYesTick: bestYesTick != null ? Number(bestYesTick) : undefined,
    bestNoTick: bestNoTick != null ? Number(bestNoTick) : undefined,
  };

  return { marketState, prices, backing: backing as bigint | undefined, isLoading: isMarketLoading };
}
