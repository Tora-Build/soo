import { useReadContracts } from "@/lib/chain-shim";
import { useMemo } from "react";
import { ABIS } from "../config/abis";
import { useChainStore } from "../store/useChainStore";
import { useDeployments } from "./useDeployments";
import { useAccount } from "@/lib/chain-shim";
import { getPollingInterval } from "../lib/polling";

/**
 * Hook to fetch Collateralizer state for a market
 * 
 * @param marketAddress - Address of the TruthMarket contract
 * @returns Collateralizer data including outcome tokens and balances
 */
export function useCollateralizer(marketAddress: `0x${string}` | undefined) {
    const { selectedChainId } = useChainStore();
    const chainId = selectedChainId ? Number(selectedChainId) : undefined;
    const { address: userAddress } = useAccount();
    const deployments = useDeployments();

    const collateralizerAddress = deployments?.contracts
        ?.Collateralizer as `0x${string}` | undefined;

    // Core tokens read (critical)
    const readTokens = useReadContracts({
        contracts: [
            {
                address: collateralizerAddress,
                abi: ABIS.Collateralizer,
                functionName: "getOutcomeTokens",
                args: marketAddress ? [marketAddress] : undefined,
                chainId,
            },
        ],
        query: {
            enabled: !!marketAddress && !!collateralizerAddress && !!selectedChainId,
            refetchInterval: getPollingInterval(chainId, 'slow'),
            staleTime: 10000,
        },
    });

    // Total collateral (optional)
    const readTotal = useReadContracts({
        contracts: [
            {
                address: collateralizerAddress,
                abi: ABIS.Collateralizer,
                functionName: "getTotalCollateral",
                args: marketAddress ? [marketAddress] : undefined,
                chainId,
            },
        ],
        query: {
            enabled: !!marketAddress && !!collateralizerAddress && !!chainId,
            refetchInterval: getPollingInterval(chainId, 'slow'),
            staleTime: 10000,
        },
    });

    // User balances (optional)
    const readBalances = useReadContracts({
        contracts: [
            {
                address: collateralizerAddress,
                abi: ABIS.Collateralizer,
                functionName: "getBalances",
                args: marketAddress && userAddress ? [marketAddress, userAddress] : undefined,
                chainId,
            },
        ],
        query: {
            enabled: !!marketAddress && !!collateralizerAddress && !!chainId && !!userAddress,
            refetchInterval: getPollingInterval(chainId, 'slow'),
            staleTime: 10000,
        },
    });

    const tokensData = readTokens.data;
    const totalData = readTotal.data;
    const { isLoading: tokensLoading, error: tokensError } = readTokens;
    const { error: totalError } = readTotal;
    const { error: balancesError } = readBalances;

    const collateralizerData = useMemo(() => {
        if (!tokensData || !marketAddress) return null;

        const tokensResult = (tokensData as any[])[0];
        const totalCollateralResult = (totalData as any[] | undefined)?.[0];
        const balancesResult = (readBalances.data as any[] | undefined)?.[0];

        // Check if critical reads failed
        if (tokensResult.status === "failure") {
            return null;
        }

        // Parse outcome tokens
        const tokens = tokensResult.result as readonly [`0x${string}`, `0x${string}`];
        const [yesToken, noToken] = tokens;

        // Parse user balances
        const balances =
            balancesResult?.status === "success"
                ? (balancesResult.result as readonly [bigint, bigint])
                : [0n, 0n];
        const [yesBalance, noBalance] = balances;

        // Parse total collateral (optional)
        const totalCollateral =
            totalCollateralResult?.status === "success"
                ? (totalCollateralResult.result as bigint)
                : 0n;

        // Calculate user's total position value (min of YES and NO)
        const completeSetBalance = yesBalance < noBalance ? yesBalance : noBalance;

        return {
            address: marketAddress,
            yesToken,
            noToken,
            yesBalance,
            noBalance,
            totalCollateral,
            completeSetBalance,
            // Helper flags
            hasYesTokens: yesBalance > 0n,
            hasNoTokens: noBalance > 0n,
            hasCompleteSets: completeSetBalance > 0n,
            canMerge: completeSetBalance > 0n,
        };
    }, [tokensData, totalData, readBalances.data, marketAddress]);

    const combinedIsLoading = tokensLoading;
    const combinedError = tokensError || totalError || balancesError;

    return {
        collateralizer: collateralizerData,
        isLoading: combinedIsLoading,
        error: combinedError,
        refetch: async () => {
            await Promise.all([readTokens.refetch(), readTotal.refetch(), readBalances.refetch()]);
        },
    };
}

/**
 * Hook to fetch outcome token metadata
 * 
 * @param tokenAddress - Address of the OutcomeToken contract
 * @returns Token metadata including name and symbol
 */
export function useOutcomeToken(tokenAddress: `0x${string}` | undefined) {
    const { selectedChainId } = useChainStore();
    const chainId = selectedChainId ? Number(selectedChainId) : undefined;

    const { data, isLoading, error } = useReadContracts({
        contracts: [
            {
                address: tokenAddress,
                abi: ABIS.OutcomeToken,
                functionName: "name",
                chainId,
            },
            {
                address: tokenAddress,
                abi: ABIS.OutcomeToken,
                functionName: "symbol",
                chainId,
            },
            {
                address: tokenAddress,
                abi: ABIS.OutcomeToken,
                functionName: "market",
                chainId,
            },
        ],
        query: {
            enabled: !!tokenAddress && !!chainId,
            refetchInterval: false,
            staleTime: Infinity,
        },
    });

    const tokenData = useMemo(() => {
        if (!data || !tokenAddress) return null;

        const [nameResult, symbolResult, marketResult] = data;

        if (
            nameResult.status === "failure" ||
            symbolResult.status === "failure"
        ) {
            return null;
        }

        const name = nameResult.result as string;
        const symbol = symbolResult.result as string;
        const market =
            marketResult.status === "success"
                ? (marketResult.result as `0x${string}`)
                : undefined;

        return {
            address: tokenAddress,
            name,
            symbol,
            market,
        };
    }, [data, tokenAddress]);

    return {
        token: tokenData,
        isLoading,
        error,
    };
}

/**
 * Type definitions
 */
export type CollateralizerData = NonNullable<
    ReturnType<typeof useCollateralizer>["collateralizer"]
>;

export type OutcomeTokenData = NonNullable<
    ReturnType<typeof useOutcomeToken>["token"]
>;
