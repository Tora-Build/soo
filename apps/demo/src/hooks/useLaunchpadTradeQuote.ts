import { useEffect, useState } from "react";
import { usePublicClient } from "@/lib/chain-shim";
import { formatUnits, parseUnits } from "@/lib/chain-shim";
import {
  LAUNCHPAD_QUOTER_ABI,
  LAUNCHPAD_MARKET_ABI,
  MARKET_V4_ABI,
  ERC20_ABI,
} from "../config/abis";
import { useChainStore } from "../store/useChainStore";
import { getDeployments } from "./useDeployments";

export interface LaunchpadTradeQuote {
  expectedCost: number;
  maxWithSlippage: number;
  priceImpact: number;
  newPriceYes: number;
  newPriceNo: number;
  fee: number;
  totalCost: number;
  inputAmount: number;
  // V6.2.3: Hypothetical next ledger state
  nextFloor: number;
  nextCeiling: number;
}

export function useLaunchpadTradeQuote(
  marketAddress: `0x${string}` | undefined,
  outcomeIndex: 0 | 1,
  shares: string,
  slippageBps: number = 50,
  decimals: number = 6,
  marketData?: { qYes: bigint; qNo: bigint; b: bigint },
) {
  const { selectedChainId } = useChainStore();
  const publicClient = usePublicClient({ chainId: Number(selectedChainId) });
  const deployments = getDeployments(Number(selectedChainId));
  const quoterAddress = deployments?.LaunchpadQuoter as
    | `0x${string}`
    | undefined;

  const [quote, setQuote] = useState<LaunchpadTradeQuote | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (
        !marketAddress ||
        !shares ||
        parseFloat(shares) === 0 ||
        !publicClient
      ) {
        if (!cancelled) setQuote(null);
        return;
      }

      console.log(
        `[Quote] Requesting for ${marketAddress}, shares: ${shares}, quoter: ${quoterAddress}`,
      );
      setIsLoading(true);
      setError(null);

      try {
        const isSell = shares.startsWith("-");
        const absSharesStr = shares.replace(/^-/, "");
        const shareAmountBig = parseUnits(absSharesStr, 18);
        const isBuy = !isSell;

        let rawCost: bigint;
        let rawFee: bigint;
        let rawNextFloor = 0n;
        let rawNextCeiling = 0n;
        let rawPriceImpact = 0n;
        let newQYes = 0n;
        let newQNo = 0n;

        if (quoterAddress) {
          console.log(`[Quote] Using On-Chain Quoter...`);
          // V6.2.3: Use On-Chain Quoter for full simulation
          const quoterResult = (await publicClient
            .readContract({
              address: quoterAddress,
              abi: LAUNCHPAD_QUOTER_ABI,
              functionName: "calculateAMMTradeQuote",
              args: [marketAddress, outcomeIndex, shareAmountBig, isBuy],
            })
            .catch((err: unknown) => {
              console.warn(
                "[Quote] Quoter failed, falling back to basic cost check",
                err,
              );
              return null;
            })) as [bigint, bigint, bigint, bigint, bigint] | null;

          if (quoterResult) {
            [rawCost, rawFee, rawNextFloor, rawNextCeiling, rawPriceImpact] =
              quoterResult;
          } else {
            console.log(
              `[Quote] Falling back to direct market call (Quoter result null)`,
            );
            const marketResult = (await publicClient.readContract({
              address: marketAddress,
              abi: MARKET_V4_ABI,
              functionName: "calculateAMMTradeCost",
              args: [outcomeIndex, shareAmountBig, isBuy],
            })) as [bigint, bigint, bigint, bigint];
            [rawCost, rawFee, newQYes, newQNo] = marketResult;
          }
        } else {
          console.log(`[Quote] Using Direct Market Call (No quoter address)`);
          const marketResult = (await publicClient.readContract({
            address: marketAddress,
            abi: MARKET_V4_ABI,
            functionName: "calculateAMMTradeCost",
            args: [outcomeIndex, shareAmountBig, isBuy],
          })) as [bigint, bigint, bigint, bigint];
          [rawCost, rawFee, newQYes, newQNo] = marketResult;
        }

        console.log(`[Quote] Result: cost=${rawCost}, fee=${rawFee}`);

        // V6.2.4: Always use 18 decimals for AMM Accounting metrics (Pure WAD Architecture)
        const WAD_DECIMALS = 18;
        const costFloat = parseFloat(formatUnits(rawCost, WAD_DECIMALS));
        const feeFloat = parseFloat(formatUnits(rawFee, WAD_DECIMALS));
        const nextFloorFloat =
          rawNextFloor > 0n
            ? parseFloat(formatUnits(rawNextFloor, WAD_DECIMALS))
            : 0;
        const nextCeilingFloat =
          rawNextCeiling > 0n
            ? parseFloat(formatUnits(rawNextCeiling, WAD_DECIMALS))
            : 0;

        const expectedCost = Math.abs(costFloat);
        const fee = feeFloat;
        const priceImpact = Number(rawPriceImpact) / 100; // bps to percent

        // Estimate next prices
        let newPriceYes = 0.5;
        let newPriceNo = 0.5;

        if (marketData && marketData.b > 0n) {
          const qY = Number(formatUnits(marketData.qYes, 18));
          const qN = Number(formatUnits(marketData.qNo, 18));
          const b = Number(formatUnits(marketData.b, 18));

          const delta = parseFloat(shares);
          let nextQY = qY;
          let nextQN = qN;

          if (outcomeIndex === 0) nextQY += delta;
          else nextQN += delta;

          const maxQ = Math.max(nextQY, nextQN);
          const eY = Math.exp((nextQY - maxQ) / b);
          const eN = Math.exp((nextQN - maxQ) / b);
          newPriceYes = eY / (eY + eN);
          newPriceNo = 1 - newPriceYes;
        }

        // Slippage Params
        const BPS = 10000;
        let maxCostParam = 0;

        if (costFloat > 0) {
          // Buy
          const totalCostWithFee = costFloat + feeFloat;
          maxCostParam = totalCostWithFee * (1 + (slippageBps + 10) / BPS);
        } else {
          // Sell
          const netProceeds = Math.abs(costFloat) - feeFloat;
          const minReceivedParam = netProceeds * (1 - (slippageBps + 10) / BPS);
          maxCostParam = -minReceivedParam;
        }

        if (!cancelled) {
          setQuote({
            expectedCost,
            maxWithSlippage: Math.abs(maxCostParam),
            priceImpact,
            newPriceYes,
            newPriceNo,
            fee,
            totalCost: expectedCost + fee,
            inputAmount: parseFloat(shares),
            nextFloor: nextFloorFloat,
            nextCeiling: nextCeilingFloat,
          });
        }
      } catch (err: any) {
        console.error("Quote Error", err);
        if (!cancelled) setError(err.message || "Failed to quote");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [
    marketAddress,
    outcomeIndex,
    shares,
    publicClient,
    quoterAddress,
    slippageBps,
    decimals,
    marketData?.qYes,
    marketData?.qNo,
    marketData?.b,
  ]);

  return { quote, isLoading, error };
}
