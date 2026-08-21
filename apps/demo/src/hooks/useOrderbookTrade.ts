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
  decodeEventLog,
  encodePacked,
  formatUnits,
  keccak256,
  maxUint256,
  parseUnits,
} from "@/lib/chain-shim";
import type { TransactionReceipt } from "@/lib/chain-shim";
import toast from "react-hot-toast";
import { ERC20_ABI, SOOTHBOOK_ABI } from "../config/abis";
import { useDeployments } from "./useDeployments";
import { useOrderStore } from "../store/useOrderStore";
import { shortenAddress } from "../utils/format";

type WriteFunctionName =
  | "bookPlace"
  | "bookCancel"
  | "bookCancelMany"
  | "cancel"
  | "redeem";
type ExecuteWriteOptions = {
  silent?: boolean;
  successMessage?: (receipt: TransactionReceipt) => string;
  /** Runs after the transaction lands successfully, silent or not — carries
   *  the receipt so callers can report the confirmed trade (Arena scoring). */
  onConfirmed?: (receipt: TransactionReceipt) => void;
};
type RestingOrderEvent = {
  id?: bigint;
  side: 0 | 1;
  tick: number;
  amount: bigint;
};
type ParsedOrderReceipt = {
  parsed: boolean;
  filledQty: bigint;
  restingQty: bigint;
  restingOrders: RestingOrderEvent[];
};

const GAS_LIMIT_CAP = 25_000_000n;
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

const isGasCapMessage = (message: string): boolean => {
  const lower = message.toLowerCase();
  return (
    lower.includes("exceeds maximum per-transaction gas limit") ||
    lower.includes("gas-per-tx limit") ||
    (lower.includes("transaction gas") && lower.includes("limit"))
  );
};

const normalizeTxErrorMessage = (error: unknown): string => {
  const message = getErrorMessage(error);
  if (isGasCapMessage(message)) {
    return "Order exceeds chain gas-per-tx limit. Split size or use a less aggressive price.";
  }

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

const fmtShares = (amountWad: bigint): string => {
  const value = Number(formatUnits(amountWad, 18));
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
};

const fmtPrice = (price: number): string =>
  `$${price.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;

const sameHex = (a: unknown, b: unknown): boolean =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();

const toBigInt = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  return 0n;
};

const EMPTY_PARSED_ORDER_RECEIPT: ParsedOrderReceipt = {
  parsed: false,
  filledQty: 0n,
  restingQty: 0n,
  restingOrders: [],
};

const parseOrderReceipt = (
  receipt: TransactionReceipt,
  soothBookAddress: `0x${string}`,
  marketKey: `0x${string}`,
  userAddress: `0x${string}`,
): ParsedOrderReceipt => {
  try {
    let filledQty = 0n;
    let restingQty = 0n;
    const restingOrders: RestingOrderEvent[] = [];
    let matchedOrderEvent = false;

    for (const log of receipt.logs) {
      if (!sameHex(log.address, soothBookAddress)) continue;
      if (log.topics.length === 0) continue;

      // Per-log try/catch: a SoothBook event missing from SOOTHBOOK_ABI
      // (e.g., post-upgrade ABI lag) must not abort parsing of sibling logs.
      let decoded;
      try {
        decoded = decodeEventLog({
          abi: SOOTHBOOK_ABI,
          data: log.data,
          topics: log.topics,
        });
      } catch {
        continue;
      }
      const args = decoded.args as Record<string, unknown>;
      if (!sameHex(args.marketKey, marketKey)) continue;

      if (decoded.eventName === "OrderFilled") {
        if (!sameHex(args.taker, userAddress)) continue;
        matchedOrderEvent = true;
        filledQty += toBigInt(args.amount);
        continue;
      }

      if (decoded.eventName === "OrderPlaced") {
        if (!sameHex(args.maker, userAddress)) continue;
        const amount = toBigInt(args.amount);
        matchedOrderEvent = true;
        restingQty += amount;
        restingOrders.push({
          id: args.orderId === undefined ? undefined : toBigInt(args.orderId),
          side: Number(args.side) as 0 | 1,
          tick: Number(args.tick),
          amount,
        });
      }
    }

    if (!matchedOrderEvent) {
      console.warn("No OrderFilled/OrderPlaced events found in order receipt");
      return EMPTY_PARSED_ORDER_RECEIPT;
    }

    return {
      parsed: true,
      filledQty,
      restingQty,
      restingOrders,
    };
  } catch (error) {
    console.warn("Failed to parse order receipt events:", error);
    return EMPTY_PARSED_ORDER_RECEIPT;
  }
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

  const { data: allowance = 0n, refetch: refetchAllowance } = useReadContract({
    address: collateralAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args:
      userAddress && orderEngineAddress
        ? [userAddress, orderEngineAddress]
        : undefined,
    query: {
      enabled: !!collateralAddress && !!userAddress && !!orderEngineAddress,
    },
  });

  const walletBalance = (walletBalanceRaw as bigint) ?? 0n;
  const allowanceAmount = (allowance as bigint) ?? 0n;
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
    await Promise.all([refetchWalletBalance(), refetchAllowance()]);
  }, [refetchAllowance, refetchWalletBalance]);

  const ensureApproval = useCallback(
    async (requiredWad: bigint) => {
      if (
        !collateralAddress ||
        !orderEngineAddress ||
        !userAddress ||
        !publicClient
      ) {
        toast.error("Missing approval context");
        return false;
      }

      const requiredRaw = fromWad(requiredWad, collateralDecimals);
      if (allowanceAmount >= requiredRaw) return true;

      const toastId = toast.loading("Approving collateral...");
      try {
        const approveHash = await writeContractAsync({
          address: collateralAddress,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [orderEngineAddress, maxUint256],
        });
        const approveReceipt = await publicClient.waitForTransactionReceipt({
          hash: approveHash,
        });
        if (approveReceipt.status !== "success") {
          throw new Error("Approval reverted on-chain");
        }
        toast.success("Approval confirmed", { id: toastId });
        await refetchAllowance();
        return true;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Approval failed";
        toast.error(message, { id: toastId });
        return false;
      }
    },
    [
      allowanceAmount,
      collateralAddress,
      collateralDecimals,
      publicClient,
      refetchAllowance,
      orderEngineAddress,
      userAddress,
      writeContractAsync,
    ],
  );

  const executeWrite = useCallback(
    async (
      label: string,
      functionName: WriteFunctionName,
      args: readonly unknown[],
      approvalWad?: bigint,
      options?: ExecuteWriteOptions,
    ) => {
      if (!soothBookAddress || !marketKey || !userAddress || !publicClient) {
        toast.error("Connect wallet and select a valid market");
        return false;
      }

      if (approvalWad && approvalWad > 0n) {
        const approved = await ensureApproval(approvalWad);
        if (!approved) return false;
      }

      try {
        const estimatedGas = await publicClient.estimateContractGas({
          address: soothBookAddress,
          abi: SOOTHBOOK_ABI,
          functionName: functionName as never,
          args: args as never,
          account: userAddress,
        });
        if (estimatedGas > GAS_LIMIT_CAP) {
          toast.error(
            `Estimated gas ${estimatedGas.toString()} exceeds chain limit ${GAS_LIMIT_CAP.toString()}. Try smaller size or less aggressive price.`,
          );
          return false;
        }
      } catch (error: unknown) {
        if (isGasCapMessage(getErrorMessage(error))) {
          toast.error(
            "Order exceeds chain gas-per-tx limit. Split into smaller orders or use a less aggressive price.",
          );
          return false;
        }
        console.error("Gas estimation failed:", error);
        toast.error(normalizeTxErrorMessage(error));
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
          toast.success(
            options?.successMessage?.(receipt) ?? "Transaction confirmed",
            { id: toastId },
          );
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
      ensureApproval,
      marketKey,
      publicClient,
      refetchBalance,
      soothBookAddress,
      userAddress,
      writeContractAsync,
    ],
  );

  const estimateGas = useCallback(
    async (functionName: WriteFunctionName, args: readonly unknown[]) => {
      if (!soothBookAddress || !userAddress || !publicClient) {
        return { gasCapHit: false };
      }

      try {
        const estimatedGas = await publicClient.estimateContractGas({
          address: soothBookAddress,
          abi: SOOTHBOOK_ABI,
          functionName: functionName as never,
          args: args as never,
          account: userAddress,
        });
        return {
          gasCapHit: estimatedGas > GAS_LIMIT_CAP,
          estimatedGas,
        };
      } catch (error: unknown) {
        if (isGasCapMessage(getErrorMessage(error))) {
          return { gasCapHit: true };
        }
        return { gasCapHit: false };
      }
    },
    [publicClient, soothBookAddress, userAddress],
  );

  // NOTE: This hook uses INVERTED outcome encoding internally — outcome===0 calls
  // buyYes, outcome===1 calls buyNo. Callers must pass the inverted value
  // (see SoothBookTerminal.tsx:312). Protocol canonical is 0=NO, 1=YES;
  // align in a follow-up PR.
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
      let maxCostWad: bigint;
      try {
        shares = parseUnits(amount, 18);
        const priceNum = Number(price);
        const amountNum = Number(amount);
        if (!Number.isFinite(priceNum) || !Number.isFinite(amountNum)) {
          toast.error("Invalid order inputs");
          return false;
        }
        const estimatedCost = Math.max(0, priceNum * amountNum);
        maxCostWad = parseUnits(estimatedCost.toFixed(18), 18);
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
      const receiptSummaries: ParsedOrderReceipt[] = [];
      const orderWriteOptions: ExecuteWriteOptions = {
        onConfirmed,
        successMessage: (receipt) => {
          const summary = parseOrderReceipt(
            receipt,
            soothBookAddress,
            marketKey,
            userAddress,
          );
          receiptSummaries.push(summary);
          if (summary.parsed && summary.restingQty > 0n) {
            return `Filled ${fmtShares(summary.filledQty)} shares; ${fmtShares(summary.restingQty)} resting at ${fmtPrice(priceNum)}`;
          }
          return "Transaction confirmed";
        },
      };

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
          maxCostWad,
          orderWriteOptions,
        );
        actualSide = bookArgs.side === 0 ? 1 : 0;
        actualTick = bookArgs.limitTick;
      }

      if (success) {
        const marketName = shortenAddress(marketAddress);
        const allReceiptsParsed =
          receiptSummaries.length > 0 &&
          receiptSummaries.every((summary) => summary.parsed);
        const restingOrders = receiptSummaries.flatMap(
          (summary) => summary.restingOrders,
        );

        if (allReceiptsParsed) {
          const totalFilledQty = receiptSummaries.reduce(
            (sum, s) => sum + s.filledQty,
            0n,
          );
          const preFillShares =
            totalFilledQty > 0n ? Number(formatUnits(totalFilledQty, 18)) : 0;
          for (const order of restingOrders) {
            const orderId =
              order.id?.toString() ?? `${order.side}:${order.tick}`;
            useOrderStore.getState().addOrder({
              id: orderId,
              marketAddress,
              marketName,
              outcome: order.side,
              price: priceNum,
              amount: Number(formatUnits(order.amount, 18)),
              timestamp: Date.now(),
              isBuy,
            });
            if (order.id !== undefined && preFillShares > 0) {
              useOrderStore.getState().setPreFillAmount(orderId, preFillShares);
              // Invalidate orders query so fill % updates immediately without
              // waiting for the 15s polling interval.
              queryClient.invalidateQueries({ queryKey: ["indexer-orders"] });
            }
          }
        } else {
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
      estimateGas,
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
        0n,
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
          0n,
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
