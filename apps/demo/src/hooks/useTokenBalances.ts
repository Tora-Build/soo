import { useReadContracts, useAccount, useChainId } from '@/lib/chain-shim';
import { ABIS } from '../config/abis';
import { getPollingInterval, getStaleTime } from '../lib/polling';

type Address = `0x${string}`;

export function useTokenBalances(tokens: Address[]) {
  const { address } = useAccount();
  const chainId = useChainId();

  const { data, isLoading, refetch } = useReadContracts({
    contracts: tokens.map(token => ({
      address: token,
      abi: ABIS.OutcomeToken, // Both OutcomeToken and ERC20 have balanceOf
      functionName: 'balanceOf',
      args: address ? [address] : undefined,
    })),
    query: {
      enabled: !!address && tokens.length > 0,
      refetchInterval: getPollingInterval(chainId, 'normal'),
      staleTime: getStaleTime(chainId),
    }
  });

  return {
    balances: data?.map(d => (d.result as bigint) ?? 0n) ?? tokens.map(() => 0n),
    isLoading,
    refetch
  };
}

