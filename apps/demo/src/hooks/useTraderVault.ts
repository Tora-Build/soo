import { useCallback, useMemo } from "react";
import { encodePacked, keccak256, parseUnits } from "@/lib/chain-shim";
import { useAccount, useChainId, useReadContracts, useWriteContract } from "@/lib/chain-shim";
import toast from "react-hot-toast";
import { ERC20_ABI, SOOTHBOOK_ABI } from "../config/abis";
import { useTokenBalances } from "./useTokenBalances";
import { useDeployments } from "./useDeployments";
import { useBaseTokenDecimals } from "./useBaseTokenDecimals";
import { demoConfig } from "../lib/config";

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
    if (!address) return [];
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
  // Spendable right now: the wallet, and ONLY the wallet.
  //
  // Seat credit is the trader's money but `book_place` never draws on it —
  // collateral is pulled from the wallet — so counting it here would show
  // funds that cannot actually fund an order. It is surfaced separately as
  // claimable, with a withdraw that moves it into the wallet first.
  const availableBalance = userUsdcBalance;
  // Committed to resting orders. Not spendable, but still the trader's.
  const reservedBalance = bookEscrow;
  // Everything the trader owns across wallet, book escrow and seat credit.
  const totalBalance = userUsdcBalance + bookEscrow + bookCredit;
  const allowance = (allowanceData?.[0]?.result as bigint | undefined) ?? 0n;

  /**
   * Move seat credit back into the wallet.
   *
   * Cancelling an order does NOT return USDC to the wallet — the refund lands
   * in the trader's seat inside the book, and `book_withdraw` is the single
   * place credit becomes tokens again. That split is what keeps a fill free of
   * token movement, but it means a trader who cancels sees their money vanish
   * from the wallet with no way to get it back: nothing in the UI called
   * `bookWithdraw` at all.
   *
   * Withdraws across every known market, since credit is per-market and the
   * Trading Account is global.
   */
  const withdrawBookCredit = useCallback(async () => {
    if (!address || bookCredit <= 0n) return false;
    let ok = false;
    for (const marketRef of marketRefs) {
      try {
        await writeContractAsync({
          address: (soothBookAddress ?? ZERO_ADDRESS) as `0x${string}`,
          abi: SOOTHBOOK_ABI,
          functionName: "bookWithdraw",
          args: [marketRef],
          chainId,
        } as never);
        ok = true;
      } catch (err) {
        // A market where the trader holds no credit reverts; that is not a
        // failure of the operation, only of that leg.
        void err;
      }
    }
    if (ok) {
      toast.success("Withdrew cancelled-order refunds to your wallet");
      await Promise.all([refetchBalances(), refetchBookAccount()]);
    } else {
      toast.error("Nothing to withdraw");
    }
    return ok;
  }, [
    address,
    bookCredit,
    marketRefs,
    soothBookAddress,
    chainId,
    writeContractAsync,
    refetchBalances,
    refetchBookAccount,
  ]);

  /**
   * Post-settlement claims, per market.
   *
   * Two separate on-chain paths, and neither is `bookWithdraw`:
   *
   *   - `redeemBookSeat` turns a seat's signed net into USDC against the
   *     resolved outcome. Without it a winning book position is unspendable —
   *     the book could trade but never pay out.
   *   - `reclaimSubsidy` returns the creator's unspent LMSR subsidy. It fails
   *     for anyone else: the program binds `lp_position` to the signer.
   *
   * Tried across every known market and reported per market, because a failure
   * usually just means "nothing owed here" and should not abort the others.
   */
  const claimSettled = useCallback(
    async (kind: "redeemBookSeat" | "reclaimSubsidy") => {
      if (!address) return false;
      let ok = 0;
      for (const marketRef of marketRefs) {
        try {
          await writeContractAsync({
            address: (soothBookAddress ?? ZERO_ADDRESS) as `0x${string}`,
            abi: SOOTHBOOK_ABI,
            functionName: kind,
            args: [marketRef],
            chainId,
          } as never);
          ok += 1;
        } catch (err) {
          void err; // nothing owed on this market, or not the creator
        }
      }
      if (ok > 0) {
        toast.success(
          kind === "redeemBookSeat"
            ? `Redeemed book position on ${ok} market(s)`
            : `Reclaimed subsidy on ${ok} market(s)`,
        );
        await Promise.all([refetchBalances(), refetchBookAccount()]);
      } else {
        toast.error("Nothing to claim — the market may not be settled yet");
      }
      return ok > 0;
    },
    [
      address,
      marketRefs,
      soothBookAddress,
      chainId,
      writeContractAsync,
      refetchBalances,
      refetchBookAccount,
    ],
  );

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
    /** Cancelled-order refunds sitting in the book, withdrawable to the wallet. */
    claimableBalance: bookCredit,
    withdrawBookCredit,
    claimSettled,
    allowance,
    isPending,
    isLoading: !address || balancesLoading || allowanceLoading,
    refetch,
    decimals,
    vaultAddress: soothBookAddress ?? ZERO_ADDRESS,
  };
}
