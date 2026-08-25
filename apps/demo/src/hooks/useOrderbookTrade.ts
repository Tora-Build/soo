import { useCallback, useMemo, useState } from "react";
import {
  parseOrderId,
  type CancelTarget,
} from "../lib/orderbook-math";
import { toBookPlace } from "../lib/book-order-mapping";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "@/lib/chain-shim";
import {
  encodePacked,
  formatUnits,
  keccak256,
  parseUnits,
} from "@/lib/chain-shim";
import type { TransactionReceipt } from "@/lib/chain-shim";
import toast from "react-hot-toast";
import { ERC20_ABI, SOOTHBOOK_ABI } from "../config/abis";
import { useDeployments } from "./useDeployments";
import { useOrderStore } from "../store/useOrderStore";
import { fetchOpenOrdersFromBook } from "./useBookOrders";
import { shortenAddress } from "../utils/format";

type WriteFunctionName =
  | "bookPlace"
  | "bookCancel"
  | "bookCancelMany"
  | "cancel"
  | "redeem";
type ExecuteWriteOptions = {
  silent?: boolean;
  /** Runs after the transaction lands successfully, silent or not — carries
   *  the receipt so callers can report the confirmed trade (Arena scoring). */
  onConfirmed?: (receipt: TransactionReceipt) => void;
};
const MIN_SHARE_CHUNK = 10n ** 18n; // 1 share in WAD

const clampTick = (price: string) => {
  const value = Number(price);
  if (!Number.isFinite(value)) return 500;
  return Math.max(1, Math.min(999, Math.round(value * 1000)));
};

const toWad = (amount: bigint, decimals: number) => {
  if (decimals === 18) return amount;
  if (decimals < 18) return amount * 10n ** BigInt(18 - decimals);
  return amount / 10n ** BigInt(decimals - 18);
};

const fromWad = (amount: bigint, decimals: number) => {
  if (decimals === 18) return amount;
  if (decimals < 18) return amount / 10n ** BigInt(18 - decimals);
  return amount * 10n ** BigInt(decimals - 18);
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? "");
  }
};

const normalizeTxErrorMessage = (error: unknown): string => {
  const message = getErrorMessage(error);

  const lower = message.toLowerCase();
  if (lower.includes("user rejected") || lower.includes("user denied")) {
    return "Transaction rejected in wallet.";
  }

  const reasonMatch = message.match(
    /reverted with the following reason:\s*([^\n]+)/i,
  );
  if (reasonMatch?.[1]) {
    return reasonMatch[1].trim();
  }

  const firstLine = message.split("\n")[0]?.trim();
  return firstLine || "Transaction failed";
};

export function useOrderbookTrade(marketAddress: `0x${string}`) {
  const { address: userAddress } = useAccount();
  const publicClient = usePublicClient();
  const { contracts } = useDeployments();
  const queryClient = useQueryClient();
  const soothBookAddress = contracts.SoothBook as `0x${string}` | undefined;
  // OrderEngine is the actual USDC custodian — SoothBook delegates the
  // safeTransferFrom call to it, so allowance must target OrderEngine.
  const orderEngineAddress = contracts.OrderEngine as `0x${string}` | undefined;

  const marketKey = useMemo(() => {
    return keccak256(encodePacked(["address"], [marketAddress]));
  }, [marketAddress]);
  const collateralAddress = contracts.MockUSDC as `0x${string}` | undefined;

  const { data: collateralDecimalsData = 6 } = useReadContract({
    address: collateralAddress,
    abi: ERC20_ABI,
    functionName: "decimals",
    query: { enabled: !!collateralAddress },
  });

  const collateralDecimals = Number(collateralDecimalsData);

  const { data: walletBalanceRaw = 0n, refetch: refetchWalletBalance } =
    useReadContract({
      address: collateralAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: userAddress ? [userAddress] : undefined,
      query: { enabled: !!collateralAddress && !!userAddress },
    });

  const walletBalance = (walletBalanceRaw as bigint) ?? 0n;
  const availableBalance = toWad(walletBalance, collateralDecimals);

  const {
    writeContractAsync,
    data: txHash,
    isPending: isWritePending,
  } = useWriteContract();
  const [localPending, setLocalPending] = useState(false);

  const { isLoading: isConfirming } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash },
  });

  const refetchBalance = useCallback(async () => {
    await refetchWalletBalance();
  }, [refetchWalletBalance]);

  const executeWrite = useCallback(
    async (
      label: string,
      functionName: WriteFunctionName,
      args: readonly unknown[],
      options?: ExecuteWriteOptions,
    ) => {
      if (!soothBookAddress || !marketKey || !userAddress || !publicClient) {
        toast.error("Connect wallet and select a valid market");
        return false;
      }

      setLocalPending(true);
      const silent = options?.silent === true;
      const toastId = silent ? "" : toast.loading(label);
      try {
        const hash = await writeContractAsync({
          address: soothBookAddress,
          abi: SOOTHBOOK_ABI,
          functionName: functionName as never,
          args: args as never,
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error("Transaction reverted on-chain");
        }
        if (!silent) {
          toast.success("Transaction confirmed", { id: toastId });
        }
        options?.onConfirmed?.(receipt);
        await refetchBalance();
        return true;
      } catch (error: unknown) {
        const message = normalizeTxErrorMessage(error);
        if (!silent) {
          toast.error(message, { id: toastId });
        }
        return false;
      } finally {
        setLocalPending(false);
      }
    },
    [
      marketKey,
      publicClient,
      refetchBalance,
      soothBookAddress,
      userAddress,
      writeContractAsync,
    ],
  );

  // `outcome` and `price` are passed raw, in caller terms. `toBookPlace` owns
  // the single complement that maps them onto the book's one YES axis, so
  // applying it here as well would invert every order.
  const placeOrder = useCallback(
    async (
      outcome: 0 | 1,
      price: string,
      amount: string,
      isBuy = true,
      escrow = true,
      onConfirmed?: (receipt: TransactionReceipt) => void,
    ) => {
      if (!marketKey || !marketAddress || !soothBookAddress || !userAddress) {
        toast.error("Market key unavailable");
        return false;
      }

      let shares: bigint;
      try {
        shares = parseUnits(amount, 18);
        const priceNum = Number(price);
        const amountNum = Number(amount);
        if (!Number.isFinite(priceNum) || !Number.isFinite(amountNum)) {
          toast.error("Invalid order inputs");
          return false;
        }
      } catch {
        toast.error("Invalid order amount");
        return false;
      }

      const directTick = clampTick(price);
      const oppositeTick = clampTick((1 - Number(price)).toFixed(4));
      const priceNum = Number(price);
      const amountNum = Number(amount);

      let success = false;
      let actualSide: 0 | 1 = outcome;
      let actualTick = directTick;
      const orderWriteOptions: ExecuteWriteOptions = { onConfirmed };

      // ── The book write path ────────────────────────────────────────────
      //
      // One call for every quadrant: on a single YES axis, buy/sell NO/YES is
      // one `side` flag plus the complement applied exactly once.
      //
      // It is also one instruction instead of a planned batch: the program
      // walks its own book, so nothing is precomputed off-chain and there is
      // nothing to go stale between planning and landing (audit finding H1).
      {
        let bookArgs;
        try {
          bookArgs = toBookPlace({
            outcome,
            price: priceNum,
            sharesWad: shares,
            isBuy,
          });
        } catch (error) {
          toast.error(getErrorMessage(error));
          return false;
        }
        success = await executeWrite(
          isBuy ? "Submitting buy order..." : "Submitting sell order...",
          "bookPlace",
          [
            marketAddress,
            bookArgs.side,
            bookArgs.limitTick,
            bookArgs.amount,
            bookArgs.matchLimit,
            bookArgs.postRemainder,
          ],
          orderWriteOptions,
        );
        actualSide = bookArgs.side === 0 ? 1 : 0;
        actualTick = bookArgs.limitTick;
      }

      if (success) {
        // A confirmed transaction has two very different outcomes here: the
        // order RESTS in the book, or it CROSSED and filled on the spot. The
        // second leaves nothing in open orders, which without this check
        // reads as "my order vanished" — when what actually happened is the
        // best possible outcome, an instant fill.
        let rested: boolean | null = null;
        try {
          const rows = await fetchOpenOrdersFromBook(
            publicClient as never,
            marketAddress,
            userAddress as `0x${string}`,
          );
          rested = rows.some(
            (r) =>
              Math.round(r.yesPrice * 1000) === actualTick &&
              (r.isBuy ? 0 : 1) === (actualSide === 0 ? 1 : 0),
          );
        } catch {
          // Read failed; stay neutral rather than claim either outcome.
        }
        if (rested === false) {
          toast.success(
            "Filled instantly — your order crossed the book and executed. It's in your position, not open orders.",
            { duration: 6000 },
          );
        } else if (rested === true) {
          toast.success("Order resting in the book", { duration: 4000 });
        }
        if (rested !== false) {
          const marketName = shortenAddress(marketAddress);
          const orderId = `${actualSide}:${actualTick}`;
          useOrderStore.getState().addOrder({
            id: orderId,
            marketAddress,
            marketName,
            outcome: actualSide,
            price: priceNum,
            amount: amountNum,
            timestamp: Date.now(),
            isBuy,
          });
        }
      }

      return success;
    },
    [
      executeWrite,
      marketKey,
      marketAddress,
      soothBookAddress,
      userAddress,
    ],
  );

  const placeSpotOrder = useCallback(
    async (outcome: 0 | 1, price: string, amount: string) => {
      return placeOrder(outcome, price, amount, false);
    },
    [placeOrder],
  );

  const executeHybridSell = useCallback(
    async (outcome: 0 | 1, price: string, amount: string) => {
      return placeOrder(outcome, price, amount, false);
    },
    [placeOrder],
  );

  const executeTakerOrder = useCallback(
    async (outcome: 0 | 1, price: string, amount: string, isBuy: boolean) => {
      return placeOrder(outcome, price, amount, isBuy);
    },
    [placeOrder],
  );

  /**
   * Cancel several orders in ONE transaction.
   *
   * Looping `cancelOrder` would mean N wallet prompts and N fees for N
   * orders, and a partial failure would leave the trader to work out which
   * ones went through. The shim chunks this at the measured transaction limit
   * and ends each chunk with a withdraw, so refunds reach the wallet.
   */
  const cancelOrders = useCallback(
    async (orderIds: string[]): Promise<boolean> => {
      const seqs: bigint[] = [];
      for (const id of orderIds) {
        const target = parseOrderId(id);
        // A level target has no meaning on this book — every order has a real
        // sequence — so skip rather than cancel something adjacent.
        if (target?.kind === "id") seqs.push(target.orderId);
      }
      if (seqs.length === 0) {
        toast.error("Nothing cancellable in the selection");
        return false;
      }
      const ok = await executeWrite(
        `Cancelling ${seqs.length} order(s)...`,
        "bookCancelMany",
        [marketAddress, seqs],
        { silent: true },
      );
      if (ok) {
        for (const id of orderIds) useOrderStore.getState().removeOrder(id);
      }
      return ok;
    },
    [executeWrite, marketAddress],
  );

  const cancelOrder = useCallback(
    async (orderId: string, options?: ExecuteWriteOptions) => {
      if (!marketKey || !soothBookAddress) {
        toast.error("Market key unavailable");
        return false;
      }

      const target = parseOrderId(orderId);
      if (!target) {
        toast.error("Unable to decode order id for cancel");
        return false;
      }

      // ── The book write path ────────────────────────────────────────────
      //
      // Cancel by the order's real sequence. Nothing is synthesised, so
      // nothing has to be parsed back — an id like "unknown-400" or
      // "yes-12345" has no side or tick to misread out of it.
      //
      // A level target has no meaning here: the book carries every order's
      // seq in the same account the ladder came from, so the caller always
      // has one.
      {
        if (target.kind !== "id") {
          toast.error(
            "Cancel needs an order id — refresh the book and try again",
          );
          return false;
        }
        return executeWrite(
          "Cancelling order...",
          "bookCancel",
          [marketAddress, target.orderId],
          { silent: options?.silent },
        );
      }
    },
    [executeWrite, marketKey, soothBookAddress, publicClient, userAddress],
  );

  const redeem = useCallback(async () => {
    if (!marketKey) {
      toast.error("Market key unavailable");
      return false;
    }
    return executeWrite("Redeeming settled payout...", "redeem", [marketKey]);
  }, [executeWrite, marketKey]);

  const depositShares = useCallback(
    async (_outcome: number, _amount: string) => {
      toast("Shares are held in wallet in SooBook mode.");
      return false;
    },
    [],
  );

  return {
    placeOrder,
    placeSpotOrder,
    executeHybridSell,
    cancelOrder,
    cancelOrders,
    executeTakerOrder,
    depositShares,
    redeem,
    isPending: localPending || isWritePending || isConfirming,
    availableBalance,
    internalYesShares: 0n,
    internalNoShares: 0n,
    refetchBalance,
  };
}
