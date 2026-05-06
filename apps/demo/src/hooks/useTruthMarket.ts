import { useReadContracts } from "@/lib/chain-shim";
import { useMemo } from "react";
import { ABIS } from "../config/abis";
import { useChainStore } from "../store/useChainStore";
import { getPollingInterval } from "../lib/polling";

/**
 * Hook to fetch TruthMarket lifecycle state
 * 
 * @param marketAddress - Address of the TruthMarket contract
 * @returns Market lifecycle data including status, deadline, roles
 */
export function useTruthMarket(marketAddress: `0x${string}` | undefined) {
    const { selectedChainId } = useChainStore();
    const chainId = selectedChainId ? Number(selectedChainId) : undefined;

    // Split core reads from string metadata reads.
    // Some RPCs/providers can be flaky on string returns; don't let that block core lifecycle state.
    const readCore = useReadContracts({
        contracts: [
            {
                address: marketAddress,
                abi: ABIS.TruthMarket,
                functionName: "isLive",
                chainId,
            },
            {
                address: marketAddress,
                abi: ABIS.TruthMarket,
                functionName: "isSettled",
                chainId,
            },
            {
                address: marketAddress,
                abi: ABIS.TruthMarket,
                functionName: "winningOutcome",
                chainId,
            },
            {
                address: marketAddress,
                abi: ABIS.TruthMarket,
                functionName: "startTime",
                chainId,
            },
            {
                address: marketAddress,
                abi: ABIS.TruthMarket,
                functionName: "deadline",
                chainId,
            },
            {
                address: marketAddress,
                abi: ABIS.TruthMarket,
                functionName: "creator",
                chainId,
            },
            {
                address: marketAddress,
                abi: ABIS.TruthMarket,
                functionName: "adjudicator",
                chainId,
            },
            {
                address: marketAddress,
                abi: ABIS.TruthMarket,
                functionName: "guardian",
                chainId,
            },
        ] as const,
        query: {
            enabled: !!marketAddress && !!selectedChainId,
            refetchInterval: getPollingInterval(chainId, 'slow'),
            staleTime: 10000,
        },
    });

    const readQuestion = useReadContracts({
        contracts: [
            {
                address: marketAddress,
                abi: ABIS.TruthMarket,
                functionName: "question",
                chainId,
            },
        ],
        query: {
            enabled: !!marketAddress && !!selectedChainId,
            refetchInterval: getPollingInterval(chainId, 'slow'),
            staleTime: 10000,
        },
    });

    const dataCore = readCore.data;
    const dataQuestion = readQuestion.data;
    const isLoading = readCore.isLoading;
    const error = readCore.error || readQuestion.error;
    const refetch = async () => {
        await Promise.all([readCore.refetch(), readQuestion.refetch()]);
    };

    const marketData = useMemo(() => {
        if (!dataCore || !marketAddress) return null;

        const [
            isLiveResult,
            isSettledResult,
            winningOutcomeResult,
            startTimeResult,
            deadlineResult,
            creatorResult,
            adjudicatorResult,
            guardianResult,
        ] = dataCore;

        const questionResult = (dataQuestion as any[] | undefined)?.[0];

        // Check if any reads failed
        if (
            isLiveResult.status === "failure" ||
            isSettledResult.status === "failure"
        ) {
            return null;
        }

        const isLive = isLiveResult.result as boolean;
        const isSettled = isSettledResult.result as boolean;
        const winningOutcome =
            winningOutcomeResult.status === "success"
                ? (winningOutcomeResult.result as number)
                : undefined;
        const deadline =
            deadlineResult.status === "success"
                ? (deadlineResult.result as bigint)
                : 0n;
        const creator =
            creatorResult.status === "success"
                ? (creatorResult.result as `0x${string}`)
                : undefined;
        const adjudicator =
            adjudicatorResult.status === "success"
                ? (adjudicatorResult.result as `0x${string}`)
                : undefined;
        const guardian =
            guardianResult.status === "success"
                ? (guardianResult.result as `0x${string}`)
                : undefined;
        const question =
            questionResult?.status === "success"
                ? (questionResult.result as string)
                : "";

        const startTimestamp = Number(startTimeResult?.result ?? 0n);
        const deadlineTimestamp = Number(deadline);
        const now = Math.floor(Date.now() / 1000);

        let status: "live" | "settled" | "expired" | "pending";
        if (isSettled) {
            status = "settled";
        } else if (now < startTimestamp) {
            status = "pending";
        } else if (now >= deadlineTimestamp) {
            status = "expired";
        } else if (isLive) {
            status = "live";
        } else {
            status = "pending";
        }

        const timeRemaining = Math.max(0, deadlineTimestamp - now);

        return {
            address: marketAddress,
            isLive,
            isSettled,
            winningOutcome,
            startTime: startTimestamp,
            deadline: deadlineTimestamp,
            creator,
            adjudicator,
            guardian,
            question,
            status,
            timeRemaining,
            // Helper flags
            isExpired: status === "expired",
            isPending: status === "pending",
            hasWinner: isSettled && winningOutcome !== undefined,
        };
    }, [dataCore, dataQuestion, marketAddress]);

    return {
        market: marketData,
        isLoading,
        error,
        refetch,
    };
}

/**
 * Type definition for TruthMarket data
 */
export type TruthMarketData = NonNullable<
    ReturnType<typeof useTruthMarket>["market"]
>;
