import { useReadContract, useAccount, useChainId } from '@/lib/chain-shim';
import { formatUnits } from '@/lib/chain-shim';
import { ABIS } from '../config/abis';
import { getPollingInterval, getStaleTime } from '../lib/polling';

export interface ClaimableAmountData {
    claimable: bigint;
    claimableFormatted: string;
    nextUnlock: bigint;
    nextUnlockDate: Date | null;
    nextAmount: bigint;
    nextAmountFormatted: string;
    hasClaimable: boolean;
    timeUntilNextUnlock: number; // milliseconds
    isLoading: boolean;
    error: Error | null;
}

/**
 * Hook to fetch the total claimable (expired) amount and next unlock prediction
 */
export function useClaimableAmount(
    ammEngineAddress: `0x${string}` | undefined
): ClaimableAmountData {
    const { address } = useAccount();
    const chainId = useChainId();

    const { data, isLoading, error } = useReadContract({
        address: ammEngineAddress,
        abi: ABIS.AMMEngine,
        functionName: 'getClaimableAmount',
        args: address ? [address] : undefined,
        query: {
            enabled: !!address && !!ammEngineAddress,
            refetchInterval: getPollingInterval(chainId, 'fast'),
            staleTime: getStaleTime(chainId),
        },
    });

    const claimable = (data as [bigint, bigint, bigint])?.[0] ?? 0n;
    const nextUnlock = (data as [bigint, bigint, bigint])?.[1] ?? 0n;
    const nextAmount = (data as [bigint, bigint, bigint])?.[2] ?? 0n;

    const now = Date.now();
    const nextUnlockMs = Number(nextUnlock) * 1000;
    const timeUntilNextUnlock = nextUnlock > 0n ? Math.max(0, nextUnlockMs - now) : 0;

    return {
        claimable,
        claimableFormatted: formatUnits(claimable, 18),
        nextUnlock,
        nextUnlockDate: nextUnlock > 0n ? new Date(nextUnlockMs) : null,
        nextAmount,
        nextAmountFormatted: formatUnits(nextAmount, 18),
        hasClaimable: claimable > 0n,
        timeUntilNextUnlock,
        isLoading,
        error: error as Error | null,
    };
}
