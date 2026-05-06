import { useReadContract, useAccount, useChainId } from '@/lib/chain-shim';
import { formatUnits } from '@/lib/chain-shim';
import { ABIS } from '../config/abis';
import { getPollingInterval, getStaleTime } from '../lib/polling';

export interface AvailableBalanceData {
    available: bigint;
    locked: bigint;
    availableFormatted: string;
    lockedFormatted: string;
    withdrawable: bigint; // available - locked
    withdrawableFormatted: string;
    isLoading: boolean;
    error: Error | null;
}

/**
 * Hook to fetch available and locked proceeds from the AMMEngine
 */
export function useAvailableBalance(
    ammEngineAddress: `0x${string}` | undefined
): AvailableBalanceData {
    const { address } = useAccount();
    const chainId = useChainId();

    const { data, isLoading, error } = useReadContract({
        address: ammEngineAddress,
        abi: ABIS.AMMEngine,
        functionName: 'getBalances',
        args: address ? [address] : undefined,
        query: {
            enabled: !!address && !!ammEngineAddress,
            refetchInterval: getPollingInterval(chainId, 'fast'),
            staleTime: getStaleTime(chainId),
        },
    });

    const available = (data as [bigint, bigint])?.[0] ?? 0n;
    const locked = (data as [bigint, bigint])?.[1] ?? 0n;
    const withdrawable = available - locked;

    return {
        available,
        locked,
        availableFormatted: formatUnits(available, 18), // AMMEngine stores internal balance in WAD
        lockedFormatted: formatUnits(locked, 18),
        withdrawable,
        withdrawableFormatted: formatUnits(withdrawable, 18),
        isLoading,
        error: error as Error | null,
    };
}
