import { useCallback, useState } from 'react';
import {
  useAccount,
  useWriteContract,
  useReadContract,
  usePublicClient,
  useChainId,
  useSwitchChain,
} from '@/lib/chain-shim';
import { parseUnits, maxUint256 } from '@/lib/chain-shim';
import { ABIS, ERC20_ABI } from '../config/abis';
import { useChainStore } from '../store/useChainStore';
import { useActivityStore } from '../store/useActivityStore';
import { useDeployments } from './useDeployments';
import marketsConfig from '../config/markets.json';
import toast from 'react-hot-toast';

export function useLaunchpadSwap(marketAddress?: `0x${string}`) {
  const { address: userAddress } = useAccount();
  const { selectedChainId } = useChainStore();
  const { config } = useDeployments();
  const ammEngineAddress = config.contracts.AMMEngine as `0x${string}`;
  const usdcAddress = config.contracts.MockUSDC as `0x${string}`;

  const walletChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: Number(selectedChainId) });
  const [isPending, setIsPending] = useState(false);
  const [isApproving, setIsApproving] = useState(false);

  const { data: usdcDecimals } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: 'decimals',
    chainId: Number(selectedChainId),
    query: {
      enabled: !!usdcAddress,
    },
  });

  const { data: walletUsdcBalance, refetch: refetchWalletBalance } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: userAddress ? [userAddress] : undefined,
    chainId: Number(selectedChainId),
    query: {
      enabled: !!usdcAddress && !!userAddress,
    },
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: userAddress && ammEngineAddress ? [userAddress, ammEngineAddress] : undefined,
    chainId: Number(selectedChainId),
    query: {
      enabled: !!usdcAddress && !!userAddress && !!ammEngineAddress,
    },
  });

  const { writeContractAsync } = useWriteContract();

  const decimals = usdcDecimals !== undefined ? Number(usdcDecimals) : 6;
  const targetChainId = Number(selectedChainId);

  const refetchBalances = useCallback(async () => {
    await Promise.all([refetchWalletBalance(), refetchAllowance()]);
  }, [refetchWalletBalance, refetchAllowance]);

  const megaethGas = targetChainId === 4326 ? 999999999n : undefined;

  const ensureWalletOnSelectedChain = useCallback(async () => {
    if (!targetChainId) return false;
    if (walletChainId === targetChainId) return true;

    const toastId = toast.loading(`Switch wallet network to Chain ${targetChainId}...`);
    try {
      await switchChainAsync?.({ chainId: targetChainId });
      toast.dismiss(toastId);
      return true;
    } catch {
      toast.error(`Please switch your wallet to Chain ${targetChainId} and try again.`, { id: toastId });
      return false;
    }
  }, [targetChainId, walletChainId, switchChainAsync]);

  const approve = useCallback(
    async (amount?: bigint) => {
      if (!ammEngineAddress || !usdcAddress || !publicClient || !userAddress) return false;

      const okChain = await ensureWalletOnSelectedChain();
      if (!okChain) return false;

      if (isApproving) return false;
      setIsApproving(true);

      const toastId = toast.loading('Checking allowance...');
      try {
        const approveAmount = amount || maxUint256;

        const currentAllowance = (await publicClient.readContract({
          address: usdcAddress,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [userAddress, ammEngineAddress],
        })) as bigint;

        if (currentAllowance >= (amount || 1n)) {
          toast.success('Already approved!', { id: toastId });
          return true;
        }

        toast.loading('Approving USDC...', { id: toastId });
        const hash = await writeContractAsync({
          address: usdcAddress,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [ammEngineAddress, approveAmount],
          chainId: targetChainId,
          gas: megaethGas,
        });

        await publicClient.waitForTransactionReceipt({ hash });
        toast.success('Approved!', { id: toastId });
        await refetchBalances();
        return true;
      } catch (error: any) {
        toast.error(error.message?.split('\n')[0] || 'Approval failed', { id: toastId });
        return false;
      } finally {
        setIsApproving(false);
      }
    },
    [
      ammEngineAddress,
      usdcAddress,
      userAddress,
      publicClient,
      writeContractAsync,
      ensureWalletOnSelectedChain,
      isApproving,
      targetChainId,
      megaethGas,
      refetchBalances,
    ]
  );

  const swap = useCallback(
    async (outcome: 0 | 1, shares: string, maxCostUsdc: string) => {
      if (!marketAddress || !ammEngineAddress || !userAddress || !publicClient) return false;

      const okChain = await ensureWalletOnSelectedChain();
      if (!okChain) return false;

      if (isPending || isApproving) return false;
      setIsPending(true);
      const isBuy = !shares.startsWith('-');
      const absShares = shares.replace('-', '');

      try {
        const deltaShares = parseUnits(absShares, 18);
        const signedDelta = isBuy ? deltaShares : -deltaShares;
        const maxCost = parseUnits(maxCostUsdc, decimals);
        const signedMaxCost = isBuy ? maxCost : -maxCost;

        if (isBuy) {
          const currentAllowance = (allowance as bigint) || 0n;
          if (currentAllowance < maxCost) {
            const approved = await approve();
            if (!approved) {
              setIsPending(false);
              return false;
            }
          }
        }

        const toastId = toast.loading(isBuy ? 'Buying shares...' : 'Selling shares...');

        const hash = await writeContractAsync({
          address: ammEngineAddress,
          abi: ABIS.AMMEngine,
          functionName: 'tradePositions',
          args: [marketAddress, outcome, signedDelta, signedMaxCost],
          chainId: targetChainId,
          gas: megaethGas,
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        if (receipt.status === 'success') {
          const action = isBuy ? 'Bought' : 'Sold';
          toast.success(`${action} ${absShares} ${outcome === 0 ? 'YES' : 'NO'} shares!`, { id: toastId });

          const markets = Array.isArray(marketsConfig) ? marketsConfig : (marketsConfig as any).markets || [];
          const marketConfig = markets.find(
            (m: any) => m.contractAddress?.toLowerCase() === marketAddress?.toLowerCase()
          );
          const marketName = marketConfig?.name || 'Launchpad Market';

          useActivityStore.getState().addActivity({
            type: 'trade',
            market: marketName,
            description: `${action} ${parseFloat(absShares).toFixed(2)} ${outcome === 0 ? 'YES' : 'NO'} shares`,
            hash,
            mode: 'real',
            timestamp: Date.now(),
            chainId: Number(selectedChainId),
          });

          await refetchBalances();
          return true;
        }

        toast.error('Transaction failed', { id: toastId });
        return false;
      } catch (error: any) {
        toast.error(error.message?.split('\n')[0] || 'Swap failed');
        return false;
      } finally {
        setIsPending(false);
      }
    },
    [
      marketAddress,
      ammEngineAddress,
      userAddress,
      publicClient,
      ensureWalletOnSelectedChain,
      isPending,
      isApproving,
      decimals,
      allowance,
      approve,
      writeContractAsync,
      targetChainId,
      megaethGas,
      selectedChainId,
      refetchBalances,
    ]
  );

  const claimUnlocked = useCallback(async () => false, []);

  const isLoading = !usdcAddress || !ammEngineAddress;

  return {
    swap,
    approve,
    claimUnlocked,
    isPending,
    isLoading,
    usdcBalance: (walletUsdcBalance as bigint) || 0n,
    allowance: (allowance as bigint) || 0n,
    decimals,
    refetch: refetchBalances,
  };
}
