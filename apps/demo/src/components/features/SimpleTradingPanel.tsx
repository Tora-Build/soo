/**
 * SimpleTradingPanel — AMM trading panel with real-time quotes
 *
 * Uses useAMMQuoteDirect for accurate LMSR cost/fee calculations
 */
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
  TrendingUp,
  TrendingDown,
  AlertCircle,
  Wallet,
  Loader2,
  ArrowRight,
  Unlock,
  Info,
  Scale,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import {
  useAccount,
  usePublicClient,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
} from "@/lib/chain-shim";
import { useAppKit } from "@/lib/chain-shim";
import {
  useAmmMarketDirect,
  useAMMQuoteDirect,
  useLaunchpadMarketDirect,
  useAMMPositionDirect,
  useAvailableBalance,
  useInvalidateQueries,
  useTruthMarketDirect,
} from "../../hooks";
import { useDeployments } from "../../hooks/useDeployments";
import { useBaseTokenDecimals } from "../../hooks/useBaseTokenDecimals";
import { ABIS, ERC20_ABI } from "../../config/abis";
import { parseUnits, formatUnits } from "@/lib/chain-shim";
import toast from "react-hot-toast";
import { cn, formatAmmAmount, formatCurrencyCompact } from "../../lib/utils";
import { useChainStore } from "../../store/useChainStore";
import { tokenLabels, tokenSymbols } from "../../lib/config";
import { logger } from "../../lib/logger";
import type { ConfirmedArenaTrade } from "../../features/arena/types";

interface SimpleTradingPanelProps {
  address: `0x${string}`;
  isGraduated?: boolean;
  isSettled?: boolean;
  variant?: "default" | "megaeth";
  /** Outcome tab preselected when the panel mounts (Arena passes the side
   *  the player picked on the card). */
  initialOutcome?: "yes" | "no";
  /** Fires once per confirmed trade transaction with the details the Arena
   *  scoring flow needs. */
  onTradeConfirmed?: (trade: ConfirmedArenaTrade) => void | Promise<void>;
}

export const SimpleTradingPanel = ({
  address,
  isGraduated = false,
  isSettled = false,
  variant = "default",
  initialOutcome = "yes",
  onTradeConfirmed,
}: SimpleTradingPanelProps) => {
  const { t } = useTranslation();
  const { isConnected, address: userAddress } = useAccount();
  const { open: openAppKit } = useAppKit();
  const { selectedChainId } = useChainStore();
  const chainId =
    typeof selectedChainId === "number"
      ? selectedChainId
      : Number(selectedChainId);
  const publicClient = usePublicClient({ chainId });
  const { amm, isLoading: isLoadingAmm } = useAmmMarketDirect(address);
  const { launchpad, isLoading: isLoadingLaunchpad } =
    useLaunchpadMarketDirect(address);
  const { market: truth } = useTruthMarketDirect(address);
  const marketIsSettled =
    truth?.isSettled === true || truth?.isFinalized === true || isSettled;
  const { contracts } = useDeployments();
  const ammEngineAddress = contracts.AMMEngine as `0x${string}` | undefined;
  // This panel trades the AMM, which is denominated in the AMM venue's token.
  // Reading `MockUSDC` here would check the book's balance against an AMM
  // cost — the panel would refuse trades the user can afford. Falls back to
  // MockUSDC so a single-token deployment still works unchanged.
  const ammTokenAddress = (contracts.AmmToken ?? contracts.MockUSDC) as
    | `0x${string}`
    | undefined;
  const { available: spendableProceeds } =
    useAvailableBalance(ammEngineAddress);
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

  const isMegaEthVariant = variant === "megaeth";

  // Contract State: 1 = YES, 0 = NO
  const [selectedOutcome, setSelectedOutcome] = useState<0 | 1>(
    initialOutcome === "no" ? 0 : 1,
  );
  // Re-arm the preselected outcome when the modal swaps in another market
  // or the caller changes the requested side.
  useEffect(() => {
    setSelectedOutcome(initialOutcome === "no" ? 0 : 1);
  }, [address, initialOutcome]);
  const [tradeMode, setTradeMode] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("10");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [pendingToastId, setPendingToastId] = useState<string | null>(null);
  const [pendingTradeInfo, setPendingTradeInfo] = useState<{
    mode: string;
    shares: string;
    outcome: string;
  } | null>(null);
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | null>(
    null,
  );

  // Contract write hooks
  const {
    writeContract: trade,
    data: tradeTxHash,
    isPending: isTrading,
  } = useWriteContract();

  // Only watch for the specific pending transaction to avoid stale success states
  const {
    isLoading: isTradePending,
    isSuccess: isTradeSuccess,
    isError: isTradeError,
    error: tradeReceiptError,
  } = useWaitForTransactionReceipt({
    hash: pendingTxHash ?? undefined,
    pollingInterval: 2000,
  });

  // Clear errors on mode/outcome switch
  useEffect(() => {
    setAmountError(null);
  }, [tradeMode, selectedOutcome]);

  const trimDecimals = (s: string, maxDecimals = 2) => {
    if (!s.includes(".")) return s;
    const [i, d] = s.split(".");
    const clipped = d.slice(0, maxDecimals).replace(/0+$/, "");
    return clipped.length ? `${i}.${clipped}` : i;
  };

  const wadToSharesInput = (wad: bigint) =>
    trimDecimals(formatUnits(wad, 18), 2);

  // Hold-to-increment on +/- buttons
  const holdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopHold = useCallback(() => {
    if (holdRef.current) {
      clearInterval(holdRef.current);
      holdRef.current = null;
    }
  }, []);
  const startHold = useCallback(
    (delta: number) => {
      stopHold();
      const step = () =>
        setAmount((prev) => {
          const n = parseFloat(prev) || 0;
          return String(Math.max(1, Math.round(n + delta)));
        });
      step();
      holdRef.current = setInterval(step, 100);
    },
    [stopHold],
  );
  useEffect(() => stopHold, [stopHold]);

  // Bug #1 & #2: Handle amount change with validation
  const handleAmountChange = (val: string) => {
    if (val === "") {
      setAmount("");
      setAmountError(null);
      return;
    }
    const num = parseFloat(val);
    if (isNaN(num)) {
      setAmountError("Enter a number.");
      return;
    }

    // Prevent negative numbers
    if (num < 0) {
      setAmountError("Enter a positive number.");
      return;
    }

    // Reasonable upper limit
    if (num > 100000000) {
      setAmountError("That size is too large.");
      return;
    }

    setAmount(val);
    setAmountError(null);
  };

  // Parse shares as a number for the quote hook
  const sharesNum = useMemo(() => {
    const parsed = parseFloat(amount);
    return isNaN(parsed) || parsed <= 0 ? 0 : parsed;
  }, [amount]);

  // Get real-time quote from LMSR calculator
  const quote = useAMMQuoteDirect(
    address,
    amount,
    selectedOutcome,
    tradeMode === "buy",
  );

  // Get USDC balance and allowance
  const { data: usdcBalance } = useReadContract({
    address: ammTokenAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [userAddress!],
    chainId,
    query: {
      enabled: !!userAddress && !!ammTokenAddress,
      refetchInterval: 15000,
    },
  });

  const decimals = useBaseTokenDecimals();

  // --- Position + Balances (for MAX + validation) ---

  const { data: ammPosition, isLoading: isLoadingPosition } =
    useAMMPositionDirect(address);
  const invalidateV8Queries = useInvalidateQueries();

  // Refetch after trade confirmation and update toast
  useEffect(() => {
    if (isTradeSuccess && pendingToastId && pendingTxHash) {
      const info = pendingTradeInfo;
      toast.success(
        `${info?.mode === "buy" ? "Bought" : "Sold"} ${info?.shares} ${info?.outcome} shares!`,
        { id: pendingToastId },
      );
      setPendingToastId(null);
      setPendingTradeInfo(null);
      setPendingTxHash(null);
      setAmount("10");
      invalidateV8Queries();
    }
  }, [
    isTradeSuccess,
    pendingToastId,
    pendingTxHash,
    pendingTradeInfo,
    invalidateV8Queries,
  ]);

  // Handle trade error
  useEffect(() => {
    if (isTradeError && pendingToastId && pendingTxHash) {
      const reason = tradeReceiptError?.message || "Transaction failed";
      toast.error(reason, { id: pendingToastId });
      setPendingToastId(null);
      setPendingTradeInfo(null);
      setPendingTxHash(null);
    }
  }, [isTradeError, pendingToastId, pendingTxHash, tradeReceiptError]);

  const yesPositionWad = ammPosition?.yesShares ?? 0n;
  const noPositionWad = ammPosition?.noShares ?? 0n;
  // 1=YES, 0=NO
  const maxSellWad = selectedOutcome === 1 ? yesPositionWad : noPositionWad;

  const walletUsdcToken = (usdcBalance as bigint | undefined) ?? 0n;
  const walletWad = useMemo(() => {
    if (decimals === 18) return walletUsdcToken;
    if (decimals < 18) return walletUsdcToken * BigInt(10 ** (18 - decimals));
    // Defensive: if token decimals > 18, downscale to WAD
    return walletUsdcToken / BigInt(10 ** (decimals - 18));
  }, [walletUsdcToken, decimals]);

  // LaunchpadEngine spends proceeds first for the base cost,
  // then pulls the remainder (+ fee) from wallet. So buying power = wallet + spendable.
  const buyingPowerWad = walletWad + (spendableProceeds ?? 0n);

  useEffect(() => {
    if (tradeTxHash) {
      logger.trade.log("Transaction hash received:", tradeTxHash);
    }
  }, [tradeTxHash]);

  // Log trade receipt status, and report the confirmed trade upward exactly
  // once per transaction — the ref guards against effect re-runs re-scoring
  // the same tx hash.
  const scoredTxRef = useRef<`0x${string}` | null>(null);
  useEffect(() => {
    if (isTradeSuccess) {
      logger.trade.log("Transaction confirmed!");
      if (
        pendingTxHash &&
        pendingTradeInfo &&
        scoredTxRef.current !== pendingTxHash &&
        onTradeConfirmed
      ) {
        scoredTxRef.current = pendingTxHash;
        void onTradeConfirmed({
          market: address,
          outcome: pendingTradeInfo.outcome === "YES" ? "yes" : "no",
          venue: "amm",
          chainId,
          txHash: pendingTxHash,
        });
      }
    }
    if (isTradeError) {
      logger.trade.error("Transaction failed:", tradeReceiptError);
    }
  }, [
    address,
    chainId,
    isTradeSuccess,
    isTradeError,
    onTradeConfirmed,
    pendingTradeInfo,
    pendingTxHash,
    tradeReceiptError,
  ]);

  const yesPrice = amm?.yesProbability ?? 0.5;
  const noPrice = amm?.noProbability ?? 0.5;
  const isMarketCreated = !!launchpad && launchpad.creator !== ZERO_ADDRESS;
  const isAmmInitialized = (amm?.liquidity ?? 0n) > 0n;
  // Contract reverts tradePositions with DeadlinePassed() once block.timestamp
  // exceeds the market's deadline. Pre-empt that revert in the UI so the
  // button shows "Deadline Passed" instead of producing a noisy decode error.
  const nowSec = Math.floor(Date.now() / 1000);
  const deadlineSec = truth?.deadline ?? 0;
  const isPastDeadline = deadlineSec > 0 && nowSec >= deadlineSec;
  const canTrade = isMarketCreated && isAmmInitialized && !isPastDeadline;
  const isInitStateLoading =
    isConnected && (isLoadingAmm || isLoadingLaunchpad);

  const isQuoteValid = useMemo(() => {
    if (!canTrade) return false;
    if (sharesNum <= 0) return false;
    if (quote.isLoading) return false;
    if (quote.error) return false;
    if (!quote.deltaShares || quote.deltaShares === 0n) return false;
    // AMM quotes return positive numbers for both cost (buys) and proceeds (sells).
    return quote.cost > 0n;
  }, [
    canTrade,
    sharesNum,
    quote.isLoading,
    quote.error,
    quote.deltaShares,
    quote.cost,
    tradeMode,
  ]);

  // Formatters
  const fmtQty = (val: bigint) =>
    Number(formatUnits(val, 18)).toLocaleString(undefined, {
      maximumFractionDigits: 0,
    });

  const wadToTokenCeil = (wadAmount: bigint) => {
    if (wadAmount <= 0n) return 0n;
    if (decimals === 18) return wadAmount;
    if (decimals < 18) {
      const factor = 10n ** BigInt(18 - decimals);
      return (wadAmount + factor - 1n) / factor;
    }
    const factor = 10n ** BigInt(decimals - 18);
    return wadAmount * factor;
  };

  // For buys, LaunchpadEngine only pulls from wallet:
  //   fromWallet = max(0, baseCost - spendableAvailable) + fee
  // Fee is always from wallet (even if baseCost is fully covered by spendable proceeds).
  const requiredFromWalletWad = useMemo(() => {
    if (tradeMode !== "buy") return 0n;
    const baseCost = quote.netCost ?? 0n; // baseCost (WAD)
    const fee = quote.fee ?? 0n; // fee (WAD)
    if (baseCost <= 0n) return 0n;
    const available = spendableProceeds ?? 0n;
    const fromBalance = available > baseCost ? baseCost : available;
    return baseCost - fromBalance + fee;
  }, [tradeMode, quote.netCost, quote.fee, spendableProceeds]);

  // Check if user has enough wallet balance for the wallet-pulled portion
  const hasEnoughBalance = useMemo(() => {
    if (tradeMode !== "buy") return true;
    if (requiredFromWalletWad <= 0n) return true;
    const requiredToken = wadToTokenCeil(requiredFromWalletWad);
    return walletUsdcToken >= requiredToken;
  }, [tradeMode, walletUsdcToken, requiredFromWalletWad, decimals]);

  const hasEnoughBuyingPower = useMemo(() => {
    if (!quote.cost) return true;
    return buyingPowerWad >= quote.cost;
  }, [buyingPowerWad, quote.cost]);

  // Check if user has enough shares to sell
  const hasEnoughShares = useMemo(() => {
    if (tradeMode === "buy") return true;
    const sharesWad = parseUnits(amount || "0", 18);
    return maxSellWad >= sharesWad;
  }, [tradeMode, amount, maxSellWad]);

  // Connect/Switch wallet handler — uses the AppKit hook directly so it
  // works in any context (including portal'd drawers where the navbar's
  // <appkit-button> may not be reachable via querySelector).
  const handleConnect = () => {
    openAppKit();
  };

  const handleMax = async () => {
    if (!isConnected) return;

    if (tradeMode === "sell") {
      const sellable = selectedOutcome === 1 ? yesPositionWad : noPositionWad;
      if (sellable <= 0n) {
        setAmount("0");
        setAmountError("No position to sell.");
        return;
      }
      setAmount(wadToSharesInput(sellable));
      setAmountError(null);
      return;
    }

    // BUY MAX — use real quotes (WAD) against total buying power (wallet + spendable)
    if (!publicClient || !ammEngineAddress || !canTrade) return;
    if (buyingPowerWad <= 0n) {
      setAmount("0");
      setAmountError("No funds available.");
      return;
    }

    const feeRateBps = Number(launchpad?.currentFeeBps ?? 500n);
    const price = selectedOutcome === 1 ? yesPrice : noPrice;
    const priceWad = BigInt(Math.max(1, Math.floor(price * 1e18)));

    const capSharesWad = 1_000_000n * 10n ** 18n;
    const estimate = (buyingPowerWad * 10n ** 18n) / priceWad; // sharesWad ~ budget / spot
    let high = estimate * 2n;
    if (high > capSharesWad) high = capSharesWad;

    const totalCostForBuyShares = async (sharesWad: bigint) => {
      // deltaShares is always positive for buys, outcome determines YES/NO
      const deltaShares = sharesWad;

      try {
        const [netCost] = (await publicClient.readContract({
          address: ammEngineAddress,
          abi: ABIS.AMMEngine,
          functionName: "getPositionQuote",
          args: [address, selectedOutcome, deltaShares],
        })) as readonly [bigint, bigint, bigint, bigint];

        const absNet = netCost < 0n ? -netCost : netCost;
        const fee = (absNet * BigInt(feeRateBps)) / 10000n;
        return netCost + fee;
      } catch (e) {
        // If contract reverts (e.g. overflow in LMSR for huge sizes),
        // treat it as "too expensive" so binary search moves lower.
        return buyingPowerWad + 1n;
      }
    };

    try {
      // If the 2x estimate still fits, use it (rare but nice UX)
      const costHigh = await totalCostForBuyShares(high);
      if (costHigh <= buyingPowerWad) {
        setAmount(wadToSharesInput(high));
        setAmountError(null);
        return;
      }

      // Binary search for best share amount under budget
      let low = 0n;
      let hi = high;
      let best = 0n;

      // ~16 iterations gives 1e6 precision down to < 0.1 share scale, enough for UX
      for (let i = 0; i < 18; i++) {
        const mid = (low + hi) / 2n;
        if (mid <= 0n) {
          low = 0n;
          continue;
        }
        const cost = await totalCostForBuyShares(mid);
        if (cost <= buyingPowerWad) {
          best = mid;
          low = mid;
        } else {
          hi = mid;
        }
      }

      if (best <= 0n) {
        setAmount("0");
        setAmountError("Not enough to buy 1 share.");
        return;
      }

      setAmount(wadToSharesInput(best));
      setAmountError(null);
    } catch (e: any) {
      logger.trade.error("Failed to compute max buy:", e);
      toast.error("Could not compute MAX right now.");
    }
  };

  const handleTrade = async () => {
    logger.trade.log("handleTrade called", {
      ammEngine: contracts.AMMEngine,
      deltaShares: quote.deltaShares?.toString(),
      sharesNum,
    });

    if (!contracts.AMMEngine) {
      toast.error("AMMEngine contract address not found");
      return;
    }

    if (!canTrade) {
      toast.error("Market is not ready for trading yet.");
      return;
    }

    if (quote.deltaShares === undefined || quote.deltaShares === 0n) {
      toast.error("Invalid quote - please enter shares amount");
      return;
    }

    const deltaShares = quote.deltaShares;

    // Slippage guard: +5% on a buy, -5% on a sell.
    //
    // Measured against `quote.netCost` — the fee-inclusive figure the program
    // compares against, returned by the quote layer as the amount paid on a
    // buy and the NET proceeds on a sell. Measuring against the raw LMSR cost
    // instead would take the fee out of the buffer rather than leaving it
    // underneath: at a 1% fee a nominal 5% buffer is really ~4%, and at a 5%
    // fee it is ~0%, so a market that has not moved still fails
    // SlippageExceeded.
    const netQuote = quote.netCost ?? quote.cost;
    const limitCost =
      tradeMode === "buy"
        ? (netQuote * 105n) / 100n
        : (netQuote * 95n) / 100n;

    logger.trade.log("Executing:", {
      market: address,
      outcome: selectedOutcome,
      deltaShares: deltaShares.toString(),
      limitCost: limitCost.toString(),
    });

    const tradeInfo = {
      mode: tradeMode,
      shares: sharesNum.toString(),
      outcome: selectedOutcome === 1 ? "YES" : "NO",
    };

    try {
      // tradePositions lives on AMMEngine, not LaunchpadEngine.
      // AMMEngine pulls USDC from wallet via transferFrom — requires allowance on AMMEngine.
      // Dynamic gas estimation based on chain and graduation impact:
      // - MegaETH (6343): 60M for graduation (code deposit = 10k gas/byte, ~44M storage gas)
      // - Other chains: 5M graduation, 2M normal
      const isMegaETH = chainId === 6343;
      const gasLimit = quote.willGraduate
        ? isMegaETH
          ? 60000000n
          : 5000000n
        : isMegaETH
          ? 30000000n
          : 2000000n;

      // Simulate first to catch specific revert reasons
      if (publicClient) {
        try {
          logger.trade.log("Simulating tradePositions...", {
            address: contracts.AMMEngine,
            args: [address, selectedOutcome, deltaShares, limitCost],
          });

          await publicClient.simulateContract({
            account: userAddress,
            address: contracts.AMMEngine as `0x${string}`,
            abi: ABIS.AMMEngine,
            functionName: "tradePositions",
            args: [address, selectedOutcome, deltaShares, limitCost],
            // Use same gas limit for simulation to catch OOG
            gas: gasLimit,
          });
          logger.trade.log("Simulation successful");
        } catch (simError: any) {
          logger.trade.error("Simulation failed:", simError);
          const reason =
            simError.cause?.reason ||
            simError.shortMessage ||
            simError.message ||
            "Unknown revert reason";
          toast.error(`Simulation failed: ${reason}`);
          return; // Abort trade
        }
      }

      trade(
        {
          address: contracts.AMMEngine as `0x${string}`,
          abi: ABIS.AMMEngine,
          functionName: "tradePositions",
          args: [address, selectedOutcome, deltaShares, limitCost],
          gas: gasLimit,
        },
        {
          onSuccess: (hash) => {
            logger.trade.log("Transaction submitted! Hash:", hash);
            const toastId = toast.loading(
              `Confirming ${tradeInfo.mode} ${tradeInfo.shares} ${tradeInfo.outcome}...`,
            );
            setPendingTxHash(hash);
            setPendingToastId(toastId);
            setPendingTradeInfo(tradeInfo);
          },
          onError: (error: any) => {
            logger.trade.error("Error:", error);
            // Prefer the full message over `shortMessage`.
            //
            // The adapter appends the diagnostic that actually identifies a
            // failure — the signing wallet and its balance — AFTER the generic
            // text, so a "short" message is exactly the part that says nothing.
            const errorMsg: string =
              error?.message || error?.cause?.shortMessage || "Transaction failed";
            toast.error(`Trade failed: ${errorMsg}`, {
              duration: 12000,
              style: { maxWidth: "44rem", whiteSpace: "pre-wrap" },
            });
          },
        },
      );
    } catch (err) {
      logger.trade.error("Unexpected error:", err);
      toast.error("Unexpected error during trade");
    }
  };

  if (marketIsSettled) {
    const winningOutcome = truth?.winningOutcome;
    return (
      <div className="p-6 text-center space-y-4">
        <div className="text-accent mb-2 flex items-center justify-center gap-2">
          <Scale className="w-5 h-5" /> Market{" "}
          {truth?.isFinalized ? "Settled" : "Resolved"}
        </div>
        <div className="text-2xl font-bold text-ink">
          Winner:{" "}
          {winningOutcome === 1
            ? "YES"
            : winningOutcome === 0
              ? "NO"
              : "INVALID"}
        </div>
        <p className="text-sm text-muted">
          Trading is closed.{" "}
          {truth?.isFinalized
            ? "You can now redeem positions."
            : "Awaiting finalization."}
        </p>
      </div>
    );
  }

  const isPending = isTrading || isTradePending;

  const getButtonContent = () => {
    if (isPending) return <Loader2 size={16} className="mr-2 animate-spin" />;
    if (isPastDeadline) return "Deadline Passed";
    if (!canTrade) return "Market Uninitialized";
    if (sharesNum <= 0) return "Enter Amount";
    if (!isQuoteValid)
      return quote.isLoading ? "Loading Quote…" : "Quote Unavailable";
    if (tradeMode === "buy") {
      if (!hasEnoughBuyingPower) return "Insufficient Balance";
      return `Buy ${selectedOutcome === 1 ? "YES" : "NO"} with ${quote.costFormatted}`;
    } else {
      if (!hasEnoughShares) return "Insufficient Position";
      return `Sell ${selectedOutcome === 1 ? "YES" : "NO"} for ${quote.costFormatted}`;
    }
  };

  const isButtonDisabled =
    isPending ||
    !canTrade ||
    sharesNum <= 0 ||
    !!amountError ||
    !isQuoteValid ||
    (tradeMode === "buy" && !hasEnoughBuyingPower) ||
    (tradeMode === "sell" && !hasEnoughShares);

  return (
    <div
      data-testid="trading-panel"
      className={cn(isMegaEthVariant && "simple-trading-panel--megaeth")}
    >
      {/* Primary Toggle: YES / NO - tab style with underline */}
      <div className="flex border-b border-rule/50">
        <button
          data-testid="outcome-yes"
          onClick={() => setSelectedOutcome(1)}
          className={cn(
            "flex-1 py-3 font-bold text-sm uppercase tracking-wider transition-all",
            isMegaEthVariant && "megaeth-outcome-tab megaeth-outcome-tab--yes",
            isMegaEthVariant && selectedOutcome === 1 && "is-active",
            selectedOutcome === 1
              ? "text-ink border-b-2 border-accent bg-accent-muted"
              : "text-muted hover:text-ink border-b-2 border-transparent",
          )}
        >
          {t("common.yes")}
        </button>
        <button
          data-testid="outcome-no"
          onClick={() => setSelectedOutcome(0)}
          className={cn(
            "flex-1 py-3 font-bold text-sm uppercase tracking-wider transition-all",
            isMegaEthVariant && "megaeth-outcome-tab megaeth-outcome-tab--no",
            isMegaEthVariant && selectedOutcome === 0 && "is-active",
            selectedOutcome === 0
              ? "text-muted border-b-2 border-error bg-raised"
              : "text-muted hover:text-ink border-b-2 border-transparent",
          )}
        >
          {t("common.no")}
        </button>
      </div>

      <div className="p-5 space-y-4">
        {/* Initialization Warning */}
        {isInitStateLoading && (
          <div className="p-2 bg-raised/40 text-xs text-muted flex items-start gap-2">
            <Loader2 size={12} className="shrink-0 mt-0.5 animate-spin" />
            <span>Checking market initialization…</span>
          </div>
        )}

        {!isInitStateLoading && isConnected && !canTrade && (
            <div className="p-2 bg-raised text-xs text-ink flex items-start gap-2">
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div>
                  Trading unavailable:{" "}
                  {!isMarketCreated
                    ? "market not found"
                    : "market not yet initialized"}
                  .
                </div>
                <div className="text-muted">
                  The market may still be pending initialization or does not
                  exist at this address.
                </div>
              </div>
            </div>
          )}

        {/* Buy/Sell Toggle — segmented control. Buy/sell is directional, so
            the active fill is a directional colour, never the loadout accent.
            The classic surface keeps its bright emerald/rose literals to match
            the deployed app; the arcade variant reads --pos/--neg so it stays
            in step with the deck's YES/NO. */}
        <div className="flex p-0.5 bg-inset">
          <button
            data-testid="trade-mode-buy"
            onClick={() => setTradeMode("buy")}
            className={cn(
              "flex-1 py-2 font-mono text-xs uppercase tracking-wider font-bold transition-all border",
              tradeMode === "buy"
                ? ""
                : "text-muted hover:text-ink border-transparent",
            )}
            style={
              tradeMode === "buy"
                ? isMegaEthVariant
                  ? {
                      backgroundColor:
                        "color-mix(in srgb, var(--pos) 14%, transparent)",
                      color: "var(--pos)",
                      borderColor:
                        "color-mix(in srgb, var(--pos) 58%, transparent)",
                    }
                  : {
                      backgroundColor: "rgba(5, 150, 105, 0.2)",
                      color: "#34d399",
                      borderColor: "rgba(5, 150, 105, 0.4)",
                    }
                : undefined
            }
          >
            {t("common.buy")}
          </button>
          <button
            data-testid="trade-mode-sell"
            onClick={() => setTradeMode("sell")}
            className={cn(
              "flex-1 py-2 font-mono text-xs uppercase tracking-wider font-bold transition-all border",
              tradeMode === "sell"
                ? ""
                : "text-muted hover:text-ink border-transparent",
            )}
            style={
              tradeMode === "sell"
                ? isMegaEthVariant
                  ? {
                      backgroundColor:
                        "color-mix(in srgb, var(--neg) 14%, transparent)",
                      color: "var(--neg)",
                      borderColor:
                        "color-mix(in srgb, var(--neg) 50%, transparent)",
                    }
                  : {
                      backgroundColor: "rgba(225, 29, 72, 0.2)",
                      color: "#fb7185",
                      borderColor: "rgba(225, 29, 72, 0.4)",
                    }
                : undefined
            }
          >
            {t("common.sell")}
          </button>
        </div>

        {/* Current Price Display - clean separate row */}
        <div className="bg-inset overflow-hidden">
          <div className="flex items-center justify-between py-2 px-3">
            <div className="font-mono text-xs text-muted uppercase tracking-[0.12em]">
              {t("trading.currentPrice")}
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-3.5 h-3.5 text-ink" />
                <span className="text-lg font-mono font-bold text-ink">
                  {isLoadingAmm ? "—" : `${(yesPrice * 100).toFixed(1)}%`}
                </span>
              </div>
              {/* Compact bar */}
              <div className="w-20 h-1.5 overflow-hidden flex bg-raised">
                <div
                  className="h-full bg-accent transition-all duration-500"
                  style={{ flex: yesPrice > 0n ? Number(yesPrice) : 1 }}
                />
                <div
                  className="h-full bg-error transition-all duration-500"
                  style={{ flex: noPrice > 0n ? Number(noPrice) : 1 }}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-mono font-bold text-muted">
                  {isLoadingAmm ? "—" : `${(noPrice * 100).toFixed(1)}%`}
                </span>
                <TrendingDown className="w-3.5 h-3.5 text-muted" />
              </div>
            </div>
          </div>
          {/* Issued Shares - compact row */}
          <div className="flex items-center justify-between px-3 py-1.5 border-t border-rule/50 bg-raised">
            <div className="font-mono text-xs text-faint uppercase tracking-[0.12em] tracking-wider">
              {t("trading.poolShares")}
            </div>
            <div className="flex items-center gap-4 text-xs font-mono">
              <span className="text-ink">
                {isLoadingAmm
                  ? "—"
                  : `${(Number(amm?.qYes ?? 0n) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 })} YES`}
              </span>
              <span className="text-faint">|</span>
              <span className="text-muted">
                {isLoadingAmm
                  ? "—"
                  : `${(Number(amm?.qNo ?? 0n) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 })} NO`}
              </span>
            </div>
          </div>
        </div>

        {/* Amount Input - Pro style */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="font-mono text-xs text-muted uppercase tracking-[0.12em]">
              {t("trading.shares")}
            </label>
            {isConnected && (
              <button
                onClick={handleMax}
                className="font-mono text-xs text-accent hover:text-accent uppercase tracking-[0.12em]"
              >
                MAX
              </button>
            )}
          </div>
          <div className="relative">
            <button
              type="button"
              onPointerDown={() => startHold(-1)}
              onPointerUp={stopHold}
              onPointerLeave={stopHold}
              onPointerCancel={stopHold}
              className="absolute left-0 top-0 h-full px-4 flex items-center justify-center text-muted hover:text-ink transition-colors z-10 select-none"
            >
              <span className="text-lg font-bold">−</span>
            </button>
            <input
              type="number"
              data-testid="shares-input"
              value={amount}
              onChange={(e) => handleAmountChange(e.target.value)}
              aria-invalid={amountError ? "true" : "false"}
              className="input-field px-14 py-3 text-xl font-bold text-center"
              placeholder="10"
              min="0"
            />
            <button
              type="button"
              onPointerDown={() => startHold(1)}
              onPointerUp={stopHold}
              onPointerLeave={stopHold}
              onPointerCancel={stopHold}
              className="absolute right-0 top-0 h-full px-4 flex items-center justify-center text-muted hover:text-ink transition-colors z-10 select-none"
            >
              <span className="text-lg font-bold">+</span>
            </button>
          </div>
          {amountError && (
            <div className="mt-1 text-xs text-muted">{amountError}</div>
          )}
          {tradeMode === "sell" && (
            <div className="mt-2 flex justify-between text-xs text-muted">
              <span>{t("trading.position")}</span>
              <span data-testid="sell-position-balance" className="font-mono text-ink flex items-center gap-1">
                {isLoadingPosition ? (
                  <>
                    <Loader2 className="w-2 h-2 animate-spin" />
                    Syncing...
                  </>
                ) : selectedOutcome === 1 ? (
                  `${trimDecimals(formatUnits(yesPositionWad, 18), 2)} YES`
                ) : (
                  `${trimDecimals(formatUnits(noPositionWad, 18), 2)} NO`
                )}
              </span>
            </div>
          )}
          {tradeMode === "buy" && (
            <div className="mt-2 flex justify-between text-xs text-muted">
              <span>{t("amm.buyingPower")}</span>
              <span className="font-mono text-ink">
                {formatAmmAmount(Number(buyingPowerWad) / 1e18)}
              </span>
            </div>
          )}
        </div>

        {/* Quick Amount Buttons - Pro style */}
        <div className="flex gap-2">
          {tradeMode === "sell"
            ? ([25, 50, 75, 100] as const).map((pct) => {
                const wad = (maxSellWad * BigInt(pct)) / 100n;
                const label = pct === 100 ? "MAX" : `${pct}%`;
                const target = wadToSharesInput(wad);
                return (
                  <button
                    key={pct}
                    onClick={() => handleAmountChange(target)}
                    disabled={maxSellWad <= 0n}
                    className={cn(
                      "flex-1 py-1.5 text-muted font-mono text-xs transition-colors",
                      maxSellWad <= 0n
                        ? "text-faint cursor-not-allowed"
                        : amount === target
                          ? "text-accent"
                          : "hover:text-ink",
                    )}
                  >
                    {label}
                  </button>
                );
              })
            : ([10, 50, 100, 500] as const).map((val) => (
                <button
                  key={val}
                  onClick={() => handleAmountChange(String(val))}
                  className={cn(
                    "flex-1 py-1.5 font-mono text-xs transition-all border cursor-pointer",
                    amount === String(val)
                      ? "text-accent border-accent bg-raised"
                      : "text-muted border-transparent hover:text-ink hover:border-accent",
                  )}
                >
                  {val}
                </button>
              ))}
        </div>

        {/* Quote Summary - Pro style */}
        <div className="p-4 bg-inset space-y-2">
          {/* USDC Amount - Primary Display */}
          <div className="flex justify-between items-center">
            <span className="text-muted text-sm">
              {tradeMode === "buy"
                ? t("trading.youPay")
                : t("trading.youReceive")}
            </span>
            <span
              data-testid="quote-cost"
              className={cn(
                "font-mono text-lg font-bold",
                tradeMode === "buy" ? "text-ink" : "text-ink",
              )}
            >
              {quote.isLoading ? (
                <span className="skeleton w-20 h-6 inline-block" />
              ) : isQuoteValid ? (
                quote.costFormatted
              ) : (
                "—"
              )}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted">
              Fee ({(quote.feeRate / 100).toFixed(1)}%)
            </span>
            <span data-testid="quote-fee" className="font-mono text-muted">
              {isQuoteValid ? quote.feeFormatted : "—"}
            </span>
          </div>

          {/* Liquidity (b) */}
          <div className="flex justify-between text-sm pt-2 border-t border-rule/50">
            <span className="text-faint">{t("trading.liquidityDepth")}</span>
            <span className="font-mono text-muted">
              {launchpad?.currentBBase
                ? `${(Number(launchpad.currentBBase) / 1e18).toFixed(2)}`
                : t("trading.notInitialized")}
            </span>
          </div>

          {/* Price Impact - only show when we have a valid quote */}
          {isQuoteValid && (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-muted">{t("trading.priceImpact")}</span>
                <span
                  className={cn(
                    "font-mono",
                    Math.abs(quote.priceImpact) > 5
                      ? "text-muted font-bold"
                      : Math.abs(quote.priceImpact) > 2
                        ? "text-muted font-bold"
                        : "text-muted",
                  )}
                >
                  {quote.priceImpact > 0 ? "+" : ""}
                  {quote.priceImpact.toFixed(2)}%
                </span>
              </div>

              {/* Impact Warnings */}
              {Math.abs(quote.priceImpact) > 5 ? (
                <div className="p-2 bg-error/30 text-xs text-muted flex items-start gap-2">
                  <AlertCircle size={12} className="shrink-0 mt-0.5" />
                  <span>
                    <strong>{t("trading.highImpact")}</strong>{" "}
                    {t("trading.highImpactDesc")}
                  </span>
                </div>
              ) : Math.abs(quote.priceImpact) > 2 ? (
                <div className="p-2 bg-inset text-xs text-muted flex items-start gap-2">
                  <AlertCircle size={12} className="shrink-0 mt-0.5" />
                  <span>{t("trading.significantImpact")}</span>
                </div>
              ) : null}
            </>
          )}

          {/* Spendable Proceeds Indicator */}
          {tradeMode === "buy" &&
            isQuoteValid &&
            spendableProceeds > 0n &&
            quote.cost > 0n && (
              <div className="flex items-center gap-2 p-2 bg-accent/30 border border-accent text-xs text-ink">
                <Unlock size={12} className="shrink-0" />
                <span>
                  {t("trading.usingUpTo")}{" "}
                  <strong>
                    {formatAmmAmount(Number(spendableProceeds) / 1e18)}
                  </strong>{" "}
                  {t("trading.fromSpendableProceeds")}
                </span>
              </div>
            )}

          {/* New Price After Trade */}
          {isQuoteValid && (
            <div className="flex justify-between text-sm pt-2 border-t border-rule/50">
              <span className="text-muted">
                {selectedOutcome === 1 ? "YES" : "NO"} {t("trading.prob")}
              </span>
              <div className="flex items-center gap-1">
                <span className="font-mono text-muted">
                  {(selectedOutcome === 1
                    ? yesPrice * 100
                    : noPrice * 100
                  ).toFixed(1)}
                  %
                </span>
                <ArrowRight className="w-3 h-3 text-faint" />
                <span
                  className={cn(
                    "font-mono",
                    selectedOutcome === 1 ? "text-ink" : "text-muted",
                  )}
                >
                  {(
                    (selectedOutcome === 1
                      ? quote.newYesPrice
                      : quote.newNoPrice) * 100
                  ).toFixed(1)}
                  %
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Quote Error */}
        {isConnected && sharesNum > 0 && !quote.isLoading && quote.error && (
          <div className="p-3 bg-error/30 text-xs text-muted flex items-center gap-2">
            <AlertCircle size={14} className="shrink-0" />
            <span>
              {quote.error.message ||
                "Quote failed for this size. Try a smaller amount."}
            </span>
          </div>
        )}

        {/* Balance Warning */}
        {isConnected &&
          tradeMode === "buy" &&
          !hasEnoughBuyingPower &&
          sharesNum > 0 && (
            <div className="flex items-center gap-2 p-3 bg-accent-muted text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 text-accent" />
              <span className="text-muted flex-1">Insufficient balance.</span>
              <a
                href="/power"
                className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent hover:underline shrink-0"
              >
                {/* Both venues share the same mock USDC mint, so the
                    faucet's one token covers this panel too. */}
                Get {tokenLabels.book} →
              </a>
            </div>
          )}

        {/* Spendable Proceeds Notice */}
        {tradeMode === "sell" && (
          <div className="flex items-center gap-2 p-3 bg-accent/30 border border-accent text-accent text-xs">
            <Info size={14} className="shrink-0" />
            <span>{t("trading.proceedsNote")}</span>
          </div>
        )}

        {/* Action Button - Pro style with contextual gradient */}
        {!isConnected ? (
          <Button
            onClick={handleConnect}
            className="btn btn-primary w-full py-4"
          >
            <Wallet size={18} className="mr-2" />
            Connect Wallet
          </Button>
        ) : (
          <Button
            onClick={handleTrade}
            disabled={isButtonDisabled}
            data-testid={tradeMode === "buy" ? "buy-button" : "sell-button"}
            className={cn(
              "btn btn-primary w-full py-4",
              isButtonDisabled && "opacity-50 cursor-not-allowed",
            )}
          >
            {getButtonContent()}
          </Button>
        )}

        {/* Faucet link */}
        {isConnected && (
          <div className="flex items-center justify-between px-1">
            <span className="text-xs text-muted font-mono">
              {t("trading.walletUsdc")}
              {formatCurrencyCompact(
                Number(walletUsdcToken) / 10 ** decimals,
                "",
              )}{" "}
              {tokenSymbols.amm}
            </span>
            <a
              href="/power"
              className="text-xs text-muted hover:text-accent transition-colors inline-flex items-center gap-1"
            >
              {t("trading.needTestUsdc")}
            </a>
          </div>
        )}
      </div>
    </div>
  );
};
