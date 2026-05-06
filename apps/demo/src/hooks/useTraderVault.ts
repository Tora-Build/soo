import { useCallback, useMemo } from "react";
import { encodePacked, keccak256, parseUnits } from "@/lib/chain-shim";
import { useAccount, useChainId, useReadContracts, useWriteContract } from "@/lib/chain-shim";
import toast from "react-hot-toast";
import { ERC20_ABI, SOOTHBOOK_ABI } from "../config/abis";
import { useTokenBalances } from "./useTokenBalances";
import { useDeployments } from "./useDeployments";
import { useBaseTokenDecimals } from "./useBaseTokenDecimals";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export function useTraderVault() {
  const { address } = useAccount();
  const chainId = useChainId();
  const { contracts } = useDeployments();
  const { writeContractAsync, isPending } = useWriteContract();
  const decimals = useBaseTokenDecimals();

  const tokenAddress = contracts.MockUSDC as `0x${string}` | undefined;
  const soothBookAddress = contracts.SoothBook as `0x${string}` | undefined;

  const { balances, isLoading: balancesLoading, refetch: refetchBalances } = useTokenBalances(
    useMemo(() => (tokenAddress ? [tokenAddress] : []), [tokenAddress])
  );

  const allowanceContracts = useMemo(() => {
    if (!address || !tokenAddress || !soothBookAddress) return [];
    return [
      {
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "allowance" as const,
        args: [address, soothBookAddress] as const,
        chainId,
      },
    ];
  }, [address, tokenAddress, soothBookAddress, chainId]);

  const { data: allowanceData, isLoading: allowanceLoading, refetch: refetchAllowance } = useReadContracts({
    contracts: allowanceContracts,
    query: {
      enabled: allowanceContracts.length > 0,
      staleTime: 10_000,
    },
  });

  const userUsdcBalance = balances[0] ?? 0n;
  const availableBalance = userUsdcBalance;
  const reservedBalance = 0n;
  const totalBalance = userUsdcBalance;
  const allowance = (allowanceData?.[0]?.result as bigint | undefined) ?? 0n;

  const approveUSDC = useCallback(
    async (amount: string) => {
      if (!tokenAddress || !soothBookAddress) {
        toast.error("USDC or SoothBook contract is unavailable on this chain.");
        return false;
      }

      const parsedAmount = amount && amount.trim().length > 0 ? parseUnits(amount, decimals) : 0n;
      await writeContractAsync({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [soothBookAddress, parsedAmount],
        chainId,
      });
      toast.success("USDC approval submitted.");
      void refetchAllowance();
      return true;
    },
    [tokenAddress, soothBookAddress, writeContractAsync, chainId, refetchAllowance, decimals]
  );

  const deposit = useCallback(async (_amount: string | bigint) => {
    toast("No vault deposit in V12. Trades use wallet USDC directly.", { icon: "ℹ️" });
  }, []);

  const withdraw = useCallback(async (_amount: string | bigint) => {
    toast("No vault withdraw in V12. Funds remain in your wallet.", { icon: "ℹ️" });
  }, []);

  const claimWinnings = useCallback(
    async (marketAddress: string) => {
      if (!soothBookAddress || !marketAddress.startsWith("0x")) {
        toast("Claim requires a valid market and SoothBook deployment.", { icon: "ℹ️" });
        return;
      }

      const marketKey = keccak256(encodePacked(["address"], [marketAddress as `0x${string}`]));
      await writeContractAsync({
        address: soothBookAddress,
        abi: SOOTHBOOK_ABI,
        functionName: "redeem",
        args: [marketKey],
        chainId,
      });
      toast.success("Redeem transaction submitted.");
    },
    [soothBookAddress, writeContractAsync, chainId]
  );

  const refetch = useCallback(async () => {
    await Promise.all([refetchBalances(), refetchAllowance()]);
  }, [refetchBalances, refetchAllowance]);

  return {
    deposit,
    withdraw,
    claimWinnings,
    approveUSDC,
    availableBalance,
    reservedBalance,
    totalBalance,
    userUsdcBalance,
    allowance,
    isPending,
    isLoading: !address || balancesLoading || allowanceLoading,
    refetch,
    decimals,
    vaultAddress: soothBookAddress ?? ZERO_ADDRESS,
  };
}
