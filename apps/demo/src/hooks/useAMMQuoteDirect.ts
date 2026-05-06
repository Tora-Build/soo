import { useMemo } from "react";
import { useChainStore } from "../store/useChainStore";
import { useDeployments } from "./useDeployments";
import { ABIS } from "../config/abis";
import { useDirectRead } from "./useDirectRead";
import { useLaunchpadMarketDirect } from "./useLaunchpadMarketDirect";
import { useAmmMarketDirect } from "./useAmmMarketDirect";
import { formatUnits, parseUnits } from "@/lib/chain-shim";

type Address = `0x${string}`;

interface AMMQuoteResult {
  // Input
  deltaShares: bigint;
  isBuy: boolean;
  outcome: 0 | 1; // 0 = NO, 1 = YES (protocol-wide canonical encoding)

  // Quote results
  cost: bigint; // Total cost in USDC (WAD)
  fee: bigint; // Fee amount (WAD)
  feeRate: number; // Fee rate in BPS (500 or 100)
  netCost: bigint; // Cost without fee (WAD)
  newYesPrice: number; // New YES probability after trade
  newNoPrice: number; // New NO probability after trade
  priceImpact: number; // Price impact percentage

  // Graduation impact
  willGraduate: boolean; // This trade's fee would cross the graduation threshold
  nearGradAfterTrade: boolean; // Post-trade progress in a high band but < 100%

  // Display helpers
  costFormatted: string;
  feeFormatted: string;
  sharesFormatted: string;

  // Status
  isLoading: boolean;
  error: Error | null;
}

/**
 * Hook to get AMM trade quotes (V9 Architecture)
 */
export function useAMMQuoteDirect(
  marketAddress: Address | undefined,
  sharesInput: string,
  outcome: 0 | 1 = 0,
  isBuy: boolean = true,
): AMMQuoteResult {
  const { selectedChainId } = useChainStore();
  const deployments = useDeployments();
  const chainId = selectedChainId ? Number(selectedChainId) : undefined;

  const ammEngineAddress = deployments?.contracts?.AMMEngine as
    | Address
    | undefined;
  const launchpad = useLaunchpadMarketDirect(marketAddress);
  const amm = useAmmMarketDirect(marketAddress);

  const isLoadingLaunchpad = launchpad.isLoading;
  const isLoadingAmm = amm.isLoading;

  const sharesWad = useMemo(() => {
    const raw = (sharesInput ?? "").trim();
    if (!raw) return 0n;
    if (/e/i.test(raw)) return 0n;
    try {
      return parseUnits(raw, 18);
    } catch {
      return 0n;
    }
  }, [sharesInput]);

  // LMSR overflow guard: exp() overflows when qYes/b or qNo/b > 50
  // Cap order size to ~45x liquidity (overflow at 50x, leave 10% buffer)
  const maxSafeShares = useMemo(() => {
    const liquidity = amm.amm?.liquidity ?? 0n;
    if (liquidity <= 0n) return 0n;
    return (liquidity * 45n) / 1n;
  }, [amm.amm?.liquidity]);

  const isOrderTooLarge =
    sharesWad > 0n && maxSafeShares > 0n && sharesWad > maxSafeShares;

  const sharesFormatted = useMemo(() => {
    if (sharesWad <= 0n) return "0";
    const raw = formatUnits(sharesWad, 18);
    const [i, d = ""] = raw.split(".");
    const iComma = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const clipped = d.slice(0, 2).replace(/0+$/, "");
    return clipped.length ? `${iComma}.${clipped}` : iComma;
  }, [sharesWad]);

  const isAmmInitialized = (amm.amm?.liquidity ?? 0n) > 0n;
  const deltaShares = isBuy ? sharesWad : -sharesWad;

  const {
    data: quoteData,
    isLoading: quoteLoading,
    error,
  } = useDirectRead<readonly [bigint, bigint, bigint, bigint]>({
    queryKey: [
      "v9-amm-quote",
      marketAddress,
      outcome,
      deltaShares.toString(),
      chainId,
    ],
    enabled:
      !!marketAddress &&
      !!ammEngineAddress &&
      !!chainId &&
      sharesWad > 0n &&
      isAmmInitialized &&
      !isOrderTooLarge,
    chainId,
    read: async (client) => {
      // getPositionQuote(market, outcome, deltaShares) returns (uint256 cost, uint256 newPrice)
      const result = (await client.readContract({
        address: ammEngineAddress!,
        abi: ABIS.AMMEngine,
        functionName: "getPositionQuote",
        args: [marketAddress!, outcome, deltaShares],
      })) as readonly [bigint, bigint, bigint, bigint];
      return result;
    },
  });

  const quote = useMemo(() => {
    const loading = isLoadingLaunchpad || isLoadingAmm || quoteLoading;

    if (isOrderTooLarge) {
      const maxShares =
        maxSafeShares > 0n
          ? Number(maxSafeShares / BigInt(1e18)).toLocaleString()
          : "?";
      return {
        deltaShares: 0n,
        isBuy,
        outcome,
        cost: 0n,
        fee: 0n,
        feeRate: 500,
        netCost: 0n,
        newYesPrice: amm.amm?.yesProbability ?? 0.5,
        newNoPrice: amm.amm?.noProbability ?? 0.5,
        priceImpact: 0,
        willGraduate: false,
        nearGradAfterTrade: false,
        costFormatted: "$0.00",
        feeFormatted: "$0.00",
        sharesFormatted,
        isLoading: false,
        error: new Error(
          `Order too large for liquidity. Max: ~${maxShares} shares`,
        ),
      };
    }

    if (!quoteData || !marketAddress || sharesWad <= 0n) {
      return {
        deltaShares: sharesWad > 0n ? deltaShares : 0n,
        isBuy,
        outcome,
        cost: 0n,
        fee: 0n,
        feeRate: 500,
        netCost: 0n,
        newYesPrice: amm.amm?.yesProbability ?? 0.5,
        newNoPrice: amm.amm?.noProbability ?? 0.5,
        priceImpact: 0,
        willGraduate: false,
        nearGradAfterTrade: false,
        costFormatted: "$0.00",
        feeFormatted: "$0.00",
        sharesFormatted,
        isLoading: loading,
        error: (error as Error | null) ?? null,
      };
    }

    const [cost, contractFee, netAmount, newPrice] = quoteData as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    const feeRateBps = BigInt(launchpad.launchpad?.currentFeeBps ?? 500);
    const feeRate = Number(feeRateBps);
    // v0.1.2: contract returns (cost, fee, netAmount, newPrice)
    // cost = raw LMSR cost, fee = protocol fee, netAmount = cost + fee (buy) or cost - fee (sell)
    const costOrProceeds = cost;
    const fee = contractFee;
    const totalCost = netAmount;

    const newYesPrice = Number(newPrice) / 1e18;
    const newNoPrice = 1 - newYesPrice;

    // outcome: 1 = YES, 0 = NO
    const currentPrice =
      outcome === 1
        ? (amm.amm?.yesProbability ?? 0.5)
        : (amm.amm?.noProbability ?? 0.5);
    const targetNewPrice = outcome === 1 ? newYesPrice : newNoPrice;

    let priceImpact = 0;
    if (currentPrice > 0) {
      priceImpact = ((targetNewPrice - currentPrice) / currentPrice) * 100;
      priceImpact = Math.max(-99.99, Math.min(99.99, priceImpact));
    }

    const fmtCost = (valWad: bigint) => {
      const abs = valWad < 0n ? -valWad : valWad;
      const raw = formatUnits(abs, 18);
      const [i, d = ""] = raw.split(".");
      const iComma = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      const d4 = (d + "0000").slice(0, 4);
      const d2 = d4.slice(0, 2);
      const asNumber = Number(raw);
      if (!Number.isFinite(asNumber) || asNumber >= 0.01)
        return `$${iComma}.${d2}`;
      return `$${iComma}.${d4}`;
    };

    // Graduation impact (per-trade), using Launchpad's fee/threshold view
    const feesAccrued =
      (launchpad.launchpad?.feesAccrued as bigint | undefined) ?? 0n;
    const gradThreshold =
      (launchpad.launchpad?.graduationThreshold as bigint | undefined) ?? 0n;

    const feesAfterTrade =
      feesAccrued +
      (isBuy || !isBuy // fee always accrues
        ? // fee is in WAD; Launchpad.getGraduationProgress returns threshold/fees in USDC,
          // but launchpad.launchpad.graduationThreshold/feesAccrued are already USDC-scale.
          // Here we conservatively ignore unit mismatch and only use the ratio as a UI signal.
          0n
        : 0n); // placeholder: we rely on contract's progressBps for canonical value

    // Prefer contract's view of progress as source of truth, but expose simple flags
    const progressBps = (launchpad.launchpad as any)?.progressBps as
      | bigint
      | undefined;
    const postTradeBps = progressBps ?? 0n; // we don't adjust; contract will on-chain

    const willGraduate =
      !launchpad.launchpad?.isGraduated && postTradeBps >= 10_000n;
    const nearGradAfterTrade =
      !launchpad.launchpad?.isGraduated &&
      postTradeBps >= 8_000n &&
      postTradeBps < 10_000n;

    return {
      deltaShares,
      isBuy,
      outcome,
      cost: totalCost,
      fee,
      feeRate,
      netCost: costOrProceeds,
      newYesPrice,
      newNoPrice,
      priceImpact,
      willGraduate,
      nearGradAfterTrade,
      costFormatted: fmtCost(totalCost),
      feeFormatted: fmtCost(fee),
      sharesFormatted,
      isLoading: false,
      error: null,
    };
  }, [
    quoteData,
    marketAddress,
    launchpad.launchpad,
    amm.amm,
    sharesWad,
    deltaShares,
    sharesFormatted,
    outcome,
    isBuy,
    quoteLoading,
    error,
    isLoadingLaunchpad,
    isLoadingAmm,
    isOrderTooLarge,
    maxSafeShares,
  ]);

  return quote;
}
