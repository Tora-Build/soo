import { useEffect } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useChainId } from '@/lib/chain-shim';
import { toast } from 'react-hot-toast';
import { ABIS } from '../config/abis';
import { getPollingInterval } from '../lib/polling';

export interface ClaimUnlockedData {
    claim: (maxClaims?: number) => void;
    isPending: boolean;
    isConfirming: boolean;
    isConfirmed: boolean;
    error: Error | null;
    txHash: `0x${string}` | undefined;
}

/**
 * Hook to execute the claimUnlocked transaction on AMMEngine
 */
export function useClaimUnlocked(
    ammEngineAddress: `0x${string}` | undefined
): ClaimUnlockedData {
    const chainId = useChainId();
    const {
        data: hash,
        writeContract,
        isPending,
        error: writeError,
    } = useWriteContract();

    const {
        isLoading: isConfirming,
        isSuccess: isConfirmed,
        error: confirmError,
    } = useWaitForTransactionReceipt({
        hash,
        pollingInterval: getPollingInterval(chainId, 'fast'),
    });

    const claim = (maxClaims: number = 50) => {
        if (!ammEngineAddress) {
            toast.error('AMM Engine address not found');
            return;
        }

        writeContract({
            address: ammEngineAddress,
            abi: ABIS.AMMEngine,
            functionName: 'claimUnlocked',
            args: [BigInt(maxClaims)],
        }, {
            onSuccess: () => toast.success('Claim transaction submitted!'),
            onError: (err) => toast.error(`Claim failed: ${err.message}`),
        });
    };

    // Show success when confirmed
    useEffect(() => {
        if (isConfirmed) {
            toast.success('Proceeds successfully claimed!');
        }
    }, [isConfirmed]);

    return {
        claim,
        isPending,
        isConfirming,
        isConfirmed,
        error: (writeError || confirmError) as Error | null,
        txHash: hash,
    };
}
