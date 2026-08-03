import { useCallback, useMemo } from "react";
import { encodePacked, keccak256, parseUnits } from "@/lib/chain-shim";
import { useAccount, useChainId, useReadContracts, useWriteContract } from "@/lib/chain-shim";
import toast from "react-hot-toast";
import { ERC20_ABI, SOOTHBOOK_ABI } from "../config/abis";
import { useTokenBalances } from "./useTokenBalances";
import { useDeployments } from "./useDeployments";
import { useBaseTokenDecimals } from "./useBaseTokenDecimals";
import { demoConfig } from "../lib/config";
import { USE_REDESIGNED_BOOK } from "../lib/book-flag";

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

  // Book seat: collateral locked behind resting orders, plus the credit a
  // cancel or a fill has already returned but which has not been withdrawn.
  //
  // `reservedBalance` used to be a hardcoded 0n, so a trader who placed orders
  // watched their wallet balance drop with nothing on the page accounting for
  // it — the collateral was sitting in the book, invisible. On the redesigned
  // book that is the normal resting state, not an edge case.
  // A seat is per-market but the Trading Account is global, so this sums over
  // every market the demo knows about. There is no on-chain market registry —
  // `demoConfig` IS the list — so a market missing from it is also missing
  // from this total.
  const marketRefs = useMemo(
    () =>
      [demoConfig.marketRef, ...demoConfig.extraMarketRefs].filter(
        (r): r is string => !!r,
      ),
    [],
  );

  const bookAccountContracts = useMemo(() => {
    if (!address || !USE_REDESIGNED_BOOK) return [];
    return marketRefs.map((marketRef) => ({
      address: (soothBookAddress ?? ZERO_ADDRESS) as `0x${string}`,
      abi: SOOTHBOOK_ABI,
      functionName: "getBookAccount" as const,
      args: [marketRef, address] as const,
      chainId,
    }));
  }, [address, marketRefs, soothBookAddress, chainId]);

  const {
    data: bookAccountData,
    refetch: refetchBookAccount,
  } = useReadContracts({
    contracts: bookAccountContracts,
    query: {
      enabled: bookAccountContracts.length > 0,
      // Matches the book cache's own window — polling faster just re-reads the
      // same cached snapshot.
      staleTime: 5_000,
      refetchInterval: 10_000,
    },
  });

  let bookCredit = 0n;
  let bookEscrow = 0n;
  for (const leg of bookAccountData ?? []) {
    const r = leg?.result as
      | readonly [bigint, bigint, bigint, bigint]
      | undefined;
    if (!r) continue; // a market with no book yet — contributes nothing
    bookCredit += r[0];
    bookEscrow += r[1];
  }

  const userUsdcBalance = balances[0] ?? 0n;
  // Spendable right now: what is in the wallet, plus credit sitting in the
  // seat that a withdraw would return.
  const availableBalance = userUsdcBalance + bookCredit;
  // Committed to resting orders. Not spendable, but still the trader's.
  const reservedBalance = bookEscrow;
  const totalBalance = availableBalance + reservedBalance;
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
    await Promise.all([
      refetchBalances(),
      refetchAllowance(),
      refetchBookAccount(),
    ]);
  }, [refetchBalances, refetchAllowance, refetchBookAccount]);

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
