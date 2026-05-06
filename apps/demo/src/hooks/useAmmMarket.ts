import { useReadContracts } from "@/lib/chain-shim";
import { useMemo } from "react";
import { ABIS } from "../config/abis";
import { useChainStore } from "../store/useChainStore";
import { useDeployments } from "./useDeployments";
import { getPollingInterval } from "../lib/polling";

/**
 * Hook to fetch AMMEngine state for a market
 * 
 * @param marketAddress - Address of the TruthMarket contract
 * @returns AMM state including quantities, prices, and trade calculations
 */
export function useAmmMarket(marketAddress: `0x${string}` | undefined) {
    const { selectedChainId } = useChainStore();
    const chainId = selectedChainId ? Number(selectedChainId) : undefined;
    const deployments = useDeployments();

    const ammEngineAddress = deployments?.contracts
        ?.AMMEngine as `0x${string}` | undefined;

    // NOTE: AMMEngine V8 ABI uses `getMarketState(market) -> (qYes, qNo, price)`
    // where `price` is the current YES price in WAD.
    const read = useReadContracts({
        contracts: [
            {
                address: ammEngineAddress,
                abi: ABIS.AMMEngine,
                functionName: "getMarketState",
                args: marketAddress ? [marketAddress] : undefined,
                chainId,
            },
        ] as const,
        query: {
            enabled: !!marketAddress && !!ammEngineAddress && !!chainId,
            refetchInterval: getPollingInterval(chainId, 'normal'),
            staleTime: 10000,
        },
    });

    const { data, isLoading, error, refetch } = read;

    const ammData = useMemo(() => {
        if (!data || !marketAddress) return null;

        const [marketStateResult] = data;

        // Check if critical reads failed
        if (marketStateResult.status === "failure") {
            return null;
        }

        // Parse market state:
        // getMarketState(market) -> (qYes: uint256, qNo: uint256, price: uint256)
        const marketState = marketStateResult.result as readonly [bigint, bigint, bigint];
        const [qYes, qNo, yesPrice] = marketState;
        const WAD = 10n ** 18n;
        const noPrice = yesPrice <= WAD ? (WAD - yesPrice) : 0n;

        // Calculate probability (price is in WAD, so divide by 1e18)
        const yesProbability = Number(yesPrice) / 1e18;
        const noProbability = Number(noPrice) / 1e18;

        return {
            address: marketAddress,
            qYes,
            qNo,
            yesPrice,
            noPrice,
            yesProbability,
            noProbability,
            // Helper flags
            hasLiquidity: qYes > 0n || qNo > 0n,
            isBalanced: Math.abs(yesProbability - 0.5) < 0.1, // Within 10% of 50/50
        };
    }, [data, marketAddress]);

    return {
        amm: ammData,
        isLoading,
        error,
        refetch,
    };
}

/**
 * Hook to calculate trade cost for a given trade
 * 
 * @param marketAddress - Address of the TruthMarket contract
 * @param deltaShares - Amount of shares to trade (positive for YES, negative for NO)
 * @returns Trade cost calculation
 */
export function useAmmTradeCost(
    marketAddress: `0x${string}` | undefined,
    deltaShares: bigint
) {
    const { selectedChainId } = useChainStore();
    const chainId = selectedChainId ? Number(selectedChainId) : undefined;
    const deployments = useDeployments();

    const ammEngineAddress = deployments?.contracts
        ?.AMMEngine as `0x${string}` | undefined;
    const outcome = deltaShares >= 0n ? 1 : 0;

    const { data, isLoading, error } = useReadContracts({
        contracts: [
            {
                address: ammEngineAddress,
                abi: ABIS.AMMEngine,
                functionName: "getPositionQuote",
                args: marketAddress && deltaShares !== 0n
                    ? [marketAddress, outcome, deltaShares]
                    : undefined,
                chainId,
            },
        ] as const,
        query: {
            enabled: !!marketAddress && !!ammEngineAddress && !!chainId && deltaShares !== 0n,
            refetchInterval: false,
            staleTime: 1000,
        },
    });

    const costData = useMemo(() => {
        if (!data || !marketAddress || deltaShares === 0n) return null;

        const [quoteResult] = data;

        if (quoteResult.status === "failure") {
            return null;
        }

        const [cost, , , newPrice] = quoteResult.result as readonly [bigint, bigint, bigint, bigint];

        return {
            cost,
            costUsd: Number(cost) / 1e18, // AMMEngine cost is in WAD
            newPrice,
            newProbability: Number(newPrice) / 1e18,
            isBuy: deltaShares > 0n,
            isSell: deltaShares < 0n,
        };
    }, [data, marketAddress, deltaShares]);

    return {
        cost: costData,
        isLoading,
        error,
    };
}

/**
 * Type definitions
 */
export type AmmMarketData = NonNullable<
    ReturnType<typeof useAmmMarket>["amm"]
>;

export type AmmTradeCostData = NonNullable<
    ReturnType<typeof useAmmTradeCost>["cost"]
>;
