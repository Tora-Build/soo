/**
 * SoothBookTerminal — 2x2 grid orderbook trading terminal for SoothBook markets.
 *
 * Layout:
 *   ┌──────────────────────┬──────────────────────┐
 *   │ Question + Price     │ Trade Form           │
 *   ├──────────────────────┼──────────────────────┤
 *   │ Order Book           │ Chart / Orders / Mint│
 *   └──────────────────────┴──────────────────────┘
 */
import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { Loader2 } from "lucide-react";
import { useAccount, useChainId, useReadContracts } from "@/lib/chain-shim";
import {
  keccak256,
  encodePacked,
  formatUnits,
  type Address,
} from "@/lib/chain-shim";
import { cn } from "../../../lib/utils";
import { useTranslation } from "react-i18next";
import { SOOTHBOOK_ABI } from "../../../config/abis";
import { useDeployments } from "../../../hooks/useDeployments";
import { useOrderbook } from "../../../hooks/useOrderbook";
import { useOrderbookTrade } from "../../../hooks/useOrderbookTrade";
import { useChainStore } from "../../../store/useChainStore";
import { shortenAddress } from "../../../utils/format";
import { MintMergePanel } from "./MintMergePanel";
import { LiquidityMap } from "./LiquidityMap";
import { HistoricalPriceCard } from "./HistoricalPriceCard";
import { UserOrdersPanel } from "./UserOrdersPanel";
import { orderCollateral } from "../../../lib/order-collateral";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SoothBookTerminalProps {
  marketAddress: `0x${string}`;
  marketQuestion?: string;
  soothBookAddress?: Address;
  /** Slot rendered at the top of the LEFT (orderbook) column. */
  beforeOrderbookPane?: React.ReactNode;
  /** Slot rendered at the bottom of the LEFT (orderbook) column. */
  afterOrderbookPane?: React.ReactNode;
  /** Slot rendered at the top of the RIGHT (trade form) column. */
  beforeTradePane?: React.ReactNode;
  /** Slot rendered at the bottom of the RIGHT (trade form) column. */
  afterTradePane?: React.ReactNode;
  /** Called when the user toggles YES/NO outcome */
  onOutcomeChange?: (outcome: "yes" | "no") => void;
}

type BottomRightTab = "orders" | "mint";

const MAX_OB_ROWS = 12;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fmtCents = (v: number) => `${(v * 100).toFixed(1)}\u00A2`;
const fmtUsd = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// Outer dispatcher: resolves the sooth_book deployment address and either
// renders the unavailable card OR mounts the heavy Active variant. Splitting
// this way means the ~30 hooks inside `SoothBookTerminalActive` only mount
// when sooth_book is deployed — Rules of Hooks stays satisfied unconditionally
// and the Solana fork (where SoothBook is undefined per docs/decision-log.md
// spike P1) renders the empty-state card without ever touching useOrderbook /
// useOrderbookTrade / the SoothBook multicalls.
export function SoothBookTerminal(props: SoothBookTerminalProps) {
  const { contracts } = useDeployments();
  const resolvedSB = (props.soothBookAddress ?? contracts.SoothBook) as
    | Address
    | undefined;

  if (!resolvedSB) {
    return <SoothBookUnavailable {...props} />;
  }

  return <SoothBookTerminalActive {...props} resolvedSB={resolvedSB} />;
}

function SoothBookUnavailable({
  marketAddress,
  marketQuestion,
  beforeOrderbookPane,
  afterOrderbookPane,
}: SoothBookTerminalProps) {
  return (
    <div className="flex flex-col lg:flex-row gap-1 bg-canvas items-start">
      <div className="flex flex-col gap-1 w-full min-w-0">
        {beforeOrderbookPane}
        <div className="bg-raised p-10 text-center space-y-3">
          <h2 className="font-sans text-lg font-medium text-ink">
            {marketQuestion || "Orderbook not available"}
          </h2>
          <p className="text-sm text-muted max-w-md mx-auto">
            Orderbook not available on this chain — the{" "}
            <span className="font-mono">sooth_book</span> program is not
            deployed (gated on spike P1).
          </p>
          <a
            href={`/amm/${marketAddress}`}
            className="inline-block mt-2 px-4 py-2 font-mono text-xs uppercase tracking-[0.12em] font-bold border border-accent text-accent hover:bg-accent-muted"
          >
            Go to AMM
          </a>
          <p className="font-mono text-[9px] text-faint pt-2">
            {marketAddress}
          </p>
        </div>
        {afterOrderbookPane}
      </div>
    </div>
  );
}

function SoothBookTerminalActive({
  marketAddress,
  marketQuestion,
  resolvedSB,
  beforeOrderbookPane,
  afterOrderbookPane,
  beforeTradePane,
  afterTradePane,
  onOutcomeChange,
}: Omit<SoothBookTerminalProps, "soothBookAddress"> & {
  resolvedSB: Address;
}) {
  const { address: user } = useAccount();
  // Use the app-selected chain (store) as source of truth for reads so users
  // browsing MegaETH still see its on-chain state when their wallet is on a
  // different chain. Fall back to wagmi chainId when no store value exists.
  const walletChainId = useChainId();
  const { selectedChainId } = useChainStore();
  const chainId = Number(selectedChainId) || walletChainId;

  const { t } = useTranslation();

  const marketKey = useMemo(() => {
    if (!marketAddress) return undefined;
    return keccak256(encodePacked(["address"], [marketAddress as Address]));
  }, [marketAddress]);

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------

  const {
    bids,
    asks,
    getOrdersForOutcome,
    isLoading: obLoading,
    refetch: refetchOb,
    userYesShares,
    userNoShares,
    yesTokenAddress,
    noTokenAddress,
  } = useOrderbook(marketAddress);

  const {
    placeOrder,
    cancelOrder,
    cancelOrders,
    isPending,
    availableBalance,
    refetchBalance,
  } = useOrderbookTrade(marketAddress);

  const { data: sbBalances } = useReadContracts({
    contracts:
      resolvedSB && marketKey && user
        ? [
            {
              address: resolvedSB,
              abi: SOOTHBOOK_ABI,
              functionName: "getBalance",
              args: [marketKey, user],
              chainId,
            },
          ]
        : [],
    query: {
      enabled: !!resolvedSB && !!marketKey && !!user,
      refetchInterval: 10_000,
    },
  });

  // Check whether the market has been activated on SoothBook.
  // `isMarketRegistered(address)` is the authoritative registration flag;
  // backing can legitimately be zero on an active but currently empty book.
  // chainId MUST be passed explicitly — without it wagmi defaults to the
  // wallet's chain, so browsing MegaETH with a Base Sepolia wallet would
  // read the wrong contract and wrongly flag the market as inactive.
  const { data: sbMarketData, isLoading: sbMarketLoading } = useReadContracts({
    contracts:
      resolvedSB && marketAddress
        ? [
            {
              address: resolvedSB,
              abi: SOOTHBOOK_ABI,
              functionName: "isMarketRegistered",
              args: [marketAddress],
              chainId,
            },
          ]
        : [],
    query: {
      enabled: !!resolvedSB && !!marketAddress,
      refetchInterval: 30_000,
    },
  });
  const isMarketActive = useMemo(() => {
    const res = sbMarketData?.[0];
    if (!res) return null; // unknown yet
    if (res.status !== "success") return false; // call failed = not registered
    return Boolean(res.result as boolean);
  }, [sbMarketData]);

  const yesSharesBig =
    sbBalances?.[0]?.status === "success"
      ? (sbBalances[0].result as [bigint, bigint])[0]
      : 0n;
  const noSharesBig =
    sbBalances?.[0]?.status === "success"
      ? (sbBalances[0].result as [bigint, bigint])[1]
      : 0n;

  // -------------------------------------------------------------------------
  // Local state
  // -------------------------------------------------------------------------

  const [selectedOutcome, setSelectedOutcomeRaw] = useState<"yes" | "no">(
    "yes",
  );
  const setSelectedOutcome = (o: "yes" | "no") => {
    setSelectedOutcomeRaw(o);
    onOutcomeChange?.(o);
  };
  const [isBuying, setIsBuying] = useState(true);
  // limitPrice stored as cents (0.1–99.9 in 0.1¢ steps), converted to fraction at submit time
  const [limitPrice, setLimitPrice] = useState("50.0");
  const [shares, setShares] = useState("1");
  const [bottomRightTab, setBottomRightTab] =
    useState<BottomRightTab>("orders");

  const isYes = selectedOutcome === "yes";
  const viewOutcome: "yes" | "no" = isYes ? "yes" : "no";

  // Outcome-relative orderbook
  const obRelative = useMemo(
    () => getOrdersForOutcome(isYes ? 0 : 1),
    [getOrdersForOutcome, isYes],
  );
  const obBids = obRelative.bids;
  const obAsks = obRelative.asks;

  // Mid price / spread
  const bestBid =
    obBids.length > 0
      ? Math.max(...obBids.map((o) => parseFloat(o.displayPrice)))
      : null;
  const bestAsk =
    obAsks.length > 0
      ? Math.min(...obAsks.map((o) => parseFloat(o.displayPrice)))
      : null;
  const midPrice =
    bestBid !== null && bestAsk !== null
      ? (bestBid + bestAsk) / 2
      : (bestBid ?? bestAsk ?? 0.5);
  const spread =
    bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

  const currentProb = useMemo(() => {
    if (bids.length === 0 && asks.length === 0) return 0.5;
    const bb =
      bids.length > 0
        ? Math.max(...bids.map((o) => parseFloat(o.yesPrice)))
        : null;
    const ba =
      asks.length > 0
        ? Math.min(...asks.map((o) => parseFloat(o.yesPrice)))
        : null;
    if (bb !== null && ba !== null) return (bb + ba) / 2;
    return bb ?? ba ?? 0.5;
  }, [bids, asks]);

  // Cost / payout — limitPrice is stored as cents (1–99)
  const limitPriceCents = parseFloat(limitPrice) || 0;
  const limitPriceNum = limitPriceCents / 100;
  const sharesNum = parseFloat(shares) || 0;
  const estimatedCost = isBuying
    ? limitPriceNum * sharesNum
    : (1 - limitPriceNum) * sharesNum;
  const payout = sharesNum;

  const relevantTokenBalance = isYes ? yesSharesBig : noSharesBig;

  // Submit-side validation
  const availableUsdc = Number(formatUnits(availableBalance, 18));
  const availableShares = Number(formatUnits(relevantTokenBalance, 18));
  // A sell does not need shares.
  //
  // The book collateralises a sell in USDC — selling YES at p IS buying NO
  // at (1 - p) — and the seat carries the negative position, so the balance
  // gate below only checks USDC collateral, never token holdings.
  const collateral = orderCollateral({
    shares: sharesNum,
    price: limitPriceNum,
    isBuying,
    isYes,
    availableUsdc,
    availableShares,
  });
  const insufficientBalance = collateral.kind === "usdc" && !!collateral.error;
  const insufficientShares = collateral.kind === "shares" && !!collateral.error;
  // Tick is uint16 in [1, 999] = price ∈ {0.001, …, 0.999}. Input is in
  // cents at 0.1¢ precision, so 0.1 ≤ value ≤ 99.9 in 0.1 increments.
  const tickOffStep =
    sharesNum > 0 &&
    Math.abs(limitPriceCents * 10 - Math.round(limitPriceCents * 10)) > 1e-9;
  const tickOutOfRange =
    sharesNum > 0 &&
    (limitPriceCents < 0.1 || limitPriceCents > 99.9 || tickOffStep);
  const validationError =
    collateral.error ??
    (tickOutOfRange ? "Price must be 0.1¢–99.9¢ in 0.1¢ steps" : null);

  const handleLevelClick = useCallback(
    (price: number) => {
      // Keep the tenth of a cent.
      //
      // The tick grid is 1/1000, so a level sits at 0.1c resolution and the
      // form validates in 0.1c steps. Rounding to a whole cent would move the
      // click OFF the level it came from: clicking 51.5c would fill the form
      // with 52c, which does not cross the order that was clicked.
      setLimitPrice((Math.round(price * 1000) / 10).toFixed(1));
    },
    [],
  );

  // Hold-to-increment helper for +/- buttons
  const holdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopHold = useCallback(() => {
    if (holdRef.current) {
      clearInterval(holdRef.current);
      holdRef.current = null;
    }
  }, []);
  const startHold = useCallback(
    (stepFn: () => void) => {
      stopHold();
      stepFn();
      holdRef.current = setInterval(stepFn, 100);
    },
    [stopHold],
  );
  const priceStep = useCallback(
    (delta: number) =>
      setLimitPrice((prev) => {
        const n = parseFloat(prev) || 0;
        const next = Math.max(0.1, Math.min(99.9, n + delta));
        return (Math.round(next * 10) / 10).toString();
      }),
    [],
  );
  const sharesStep = useCallback(
    (delta: number) =>
      setShares((prev) => {
        const n = parseFloat(prev) || 0;
        const next = Math.max(1, n + delta);
        return String(Math.round(next));
      }),
    [],
  );
  useEffect(() => stopHold, [stopHold]);

  const handleSubmit = useCallback(async () => {
    if (!shares || sharesNum <= 0 || isPending) return;
    if (insufficientBalance || insufficientShares || tickOutOfRange) return;
    const outcome: 0 | 1 = isYes ? 0 : 1;
    // Send the RAW price of the selected outcome — `toBookPlace` (via
    // `placeOrder` -> `useOrderbookTrade`) does its own YES-axis complement
    // from `outcome`, per its documented contract ("price: Price of the
    // outcome named above"). Pre-complementing here (`isYes ? limitPriceNum
    // : 1 - limitPriceNum`) would compound with that complement into the
    // WRONG tick for every NO order, silently: a 49c "buy NO" would rest at
    // the tick for 49c "sell NO" — no error, just orders on mirror prices.
    // Exactly ONE layer owns the complement, and it is toBookPlace.
    const success = await placeOrder(
      outcome,
      limitPriceNum.toFixed(4),
      shares,
      isBuying,
      // Sell is always escrow (burn shares); buy is non-escrow.
      !isBuying,
    );
    if (success) {
      setShares("");
      refetchOb();
      refetchBalance();
    }
  }, [
    shares,
    sharesNum,
    isPending,
    isYes,
    limitPriceNum,
    placeOrder,
    isBuying,
    refetchOb,
    refetchBalance,
    insufficientBalance,
    insufficientShares,
    tickOutOfRange,
  ]);

  // Auto-set price from best bid/ask on outcome/side change
  useEffect(() => {
    const target = isBuying ? bestAsk : bestBid;
    if (target !== null)
      setLimitPrice((Math.round(target * 1000) / 10).toString());
  }, [selectedOutcome, isBuying]); // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // Orderbook rendering
  // -------------------------------------------------------------------------

  const sortedBids = useMemo(
    () =>
      [...obBids]
        .sort((a, b) => parseFloat(b.displayPrice) - parseFloat(a.displayPrice))
        .slice(0, MAX_OB_ROWS),
    [obBids],
  );
  const sortedAsks = useMemo(
    () =>
      [...obAsks]
        .sort((a, b) => parseFloat(a.displayPrice) - parseFloat(b.displayPrice))
        .slice(0, MAX_OB_ROWS),
    [obAsks],
  );
  const maxBidSize = useMemo(
    () => Math.max(...sortedBids.map((o) => parseFloat(o.amount)), 1),
    [sortedBids],
  );
  const maxAskSize = useMemo(
    () => Math.max(...sortedAsks.map((o) => parseFloat(o.amount)), 1),
    [sortedAsks],
  );
  const overflowBids =
    obBids.length > MAX_OB_ROWS ? obBids.length - MAX_OB_ROWS : 0;
  const overflowAsks =
    obAsks.length > MAX_OB_ROWS ? obAsks.length - MAX_OB_ROWS : 0;

  // -------------------------------------------------------------------------
  // Derived labels
  // -------------------------------------------------------------------------

  const ctaLabel = `${isBuying ? "BUY" : "SELL"} ${isYes ? "YES" : "NO"}`;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Block trading UI for markets that haven't graduated to SoothBook yet
  if (isMarketActive === false) {
    return (
      <div className="flex flex-col lg:flex-row gap-1 bg-canvas items-start">
        <div className="flex flex-col gap-1 w-full lg:flex-1 min-w-0">
          {beforeOrderbookPane}
          <div className="bg-raised p-10 text-center space-y-3">
            <h2 className="font-sans text-lg font-medium text-ink">
              {marketQuestion || t("orderbook.notOnSoothBook")}
            </h2>
            <p className="text-sm text-muted max-w-md mx-auto">
              {t("orderbook.bondingPhase")}
            </p>
            <a
              href={`/amm/${marketAddress}`}
              className="inline-block mt-2 px-4 py-2 font-mono text-xs uppercase tracking-[0.12em] font-bold border border-accent text-accent hover:bg-accent-muted"
            >
              {t("orderbook.goToAmm")}
            </a>
            <p className="font-mono text-[9px] text-faint pt-2">
              {marketAddress}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-1 w-full lg:flex-1 min-w-0">
          {beforeTradePane}
          {afterTradePane}
        </div>
      </div>
    );
  }

  // While we don't know yet whether the market is active, avoid flashing the
  // trading panel (which would let the user click into a failing tx).
  if (isMarketActive === null && sbMarketLoading) {
    return (
      <div className="flex flex-col lg:flex-row gap-1 bg-canvas items-start">
        <div className="flex flex-col gap-1 w-full lg:flex-1 min-w-0">
          {beforeOrderbookPane}
          <div className="bg-raised p-10 text-center">
            <Loader2 className="w-5 h-5 text-muted animate-spin mx-auto" />
          </div>
        </div>
        <div className="flex flex-col gap-1 w-full lg:flex-1 min-w-0">
          {beforeTradePane}
          {afterTradePane}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-1 bg-canvas items-start">
      {/* LEFT COLUMN — orderbook + liquidity map */}
      <div className="flex flex-col gap-1 w-full lg:flex-1 min-w-0">
        {beforeOrderbookPane}
        <div className="bg-raised p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <span className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
                {marketQuestion || t("uc.pro.visuals.liquidityMap")}
              </span>
              <div className="mt-3 flex items-center gap-3">
                <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-accent">
                  <span className="w-1.5 h-1.5 bg-accent" />
                  {t("common.live")}
                </span>
                <span className="font-mono text-xs text-faint">
                  {shortenAddress(marketAddress)}
                </span>
              </div>
            </div>

            <div className="flex flex-col items-end shrink-0">
              <span className="font-mono text-3xl text-ink tabular-nums font-bold leading-none">
                {fmtCents(midPrice)}
              </span>
              <div className="mt-1.5 flex items-center gap-3">
                {spread !== null && (
                  <span className="font-mono text-xs text-faint uppercase tracking-[0.12em] tabular-nums">
                    {t("orderbook.spread")} {(spread * 100).toFixed(1)}
                    {"\u00A2"}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Liquidity Map */}
          <div className="mt-4">
            <LiquidityMap
              bids={bids}
              asks={asks}
              currentProb={currentProb}
              ammProb={currentProb}
              isLoading={obLoading}
              viewOutcome={viewOutcome}
            />
          </div>
        </div>

        {/* Orderbook */}
        <div className="bg-raised p-4 overflow-y-auto flex-1">
          <div className="flex items-center justify-between mb-3">
            <span className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
              {t("orderbook.orderBook")} ({viewOutcome.toUpperCase()})
            </span>
            {obLoading && (
              <Loader2 className="w-3 h-3 text-faint animate-spin" />
            )}
          </div>

          <div className="bg-inset">
            {/* Column headers */}
            <div className="grid grid-cols-[1fr_72px_1fr] font-mono text-[9px] uppercase tracking-[0.12em] text-faint border-b border-rule">
              <div className="flex justify-between px-3 py-2">
                <span>{t("orderbook.size")}</span>
                <span>{t("orderbook.bid")}</span>
              </div>
              <div className="flex items-center justify-center border-x border-rule">
                <span>{t("orderbook.mid")}</span>
              </div>
              <div className="flex justify-between px-3 py-2">
                <span>{t("orderbook.ask")}</span>
                <span>{t("orderbook.size")}</span>
              </div>
            </div>

            {/* Rows */}
            <div className="grid grid-cols-[1fr_72px_1fr]">
              {Array.from({ length: MAX_OB_ROWS }).map((_, i) => (
                <OBRow
                  key={i}
                  bid={sortedBids[i]}
                  ask={sortedAsks[i]}
                  maxBidSize={maxBidSize}
                  maxAskSize={maxAskSize}
                  onClickBid={
                    sortedBids[i]
                      ? () =>
                          handleLevelClick(
                            parseFloat(sortedBids[i].displayPrice),
                          )
                      : undefined
                  }
                  onClickAsk={
                    sortedAsks[i]
                      ? () =>
                          handleLevelClick(
                            parseFloat(sortedAsks[i].displayPrice),
                          )
                      : undefined
                  }
                  midSlot={
                    i === 0 ? (
                      <div className="flex flex-col items-center gap-0.5 py-1">
                        <span className="font-mono text-sm font-bold tabular-nums text-ink">
                          {fmtCents(midPrice)}
                        </span>
                        {spread !== null && (
                          <span className="font-mono text-[9px] text-faint tabular-nums">
                            {(spread * 100).toFixed(1)}
                            {"\u00A2"} spd
                          </span>
                        )}
                      </div>
                    ) : null
                  }
                />
              ))}
            </div>

            {/* Overflow */}
            {(overflowBids > 0 || overflowAsks > 0) && (
              <div className="grid grid-cols-[1fr_72px_1fr] font-mono text-[9px] text-faint border-t border-rule">
                <div className="px-3 py-1">
                  {overflowBids > 0 && `+${overflowBids} more`}
                </div>
                <div />
                <div className="px-3 py-1 text-right">
                  {overflowAsks > 0 && `+${overflowAsks} more`}
                </div>
              </div>
            )}
          </div>
        </div>
        {afterOrderbookPane}
      </div>
      {/* end left column */}

      {/* RIGHT COLUMN — trade form + tabs */}
      <div className="flex flex-col gap-1 w-full lg:flex-1 min-w-0 self-stretch lg:self-start">
        {beforeTradePane}
        <div className="bg-raised">
          {/* YES / NO selector — flush with card edges */}
          <div className="flex border-b border-rule/50">
            <button
              data-testid="ob-outcome-yes"
              onClick={() => setSelectedOutcome("yes")}
              className={cn(
                "flex-1 py-3 font-bold text-sm uppercase tracking-wider transition-all",
                selectedOutcome === "yes"
                  ? "text-ink border-b-2 border-accent bg-accent-muted"
                  : "text-muted hover:text-ink border-b-2 border-transparent",
              )}
            >
              YES
            </button>
            <button
              data-testid="ob-outcome-no"
              onClick={() => setSelectedOutcome("no")}
              className={cn(
                "flex-1 py-3 font-bold text-sm uppercase tracking-wider transition-all",
                selectedOutcome === "no"
                  ? "text-muted border-b-2 border-error bg-raised"
                  : "text-muted hover:text-ink border-b-2 border-transparent",
              )}
            >
              NO
            </button>
          </div>
          <div className="p-5 space-y-4">
            {/* Buy / Sell toggle — segmented control. Active colors use
                bright emerald/rose (pre-palette-refactor values) rather
                than the desaturated --pos/--neg tokens, matching the
                deployed app aesthetic. */}
            <div className="flex p-0.5 bg-inset border border-rule">
              <button
                data-testid="ob-side-buy"
                onClick={() => setIsBuying(true)}
                className={cn(
                  "flex-1 py-2 font-mono text-xs uppercase tracking-wider font-bold transition-all border",
                  isBuying
                    ? ""
                    : "text-muted hover:text-ink border-transparent",
                )}
                style={
                  isBuying
                    ? {
                        backgroundColor: "rgba(5, 150, 105, 0.2)",
                        color: "#34d399",
                        borderColor: "rgba(5, 150, 105, 0.4)",
                      }
                    : undefined
                }
              >
                Buy
              </button>
              <button
                data-testid="ob-side-sell"
                onClick={() => setIsBuying(false)}
                className={cn(
                  "flex-1 py-2 font-mono text-xs uppercase tracking-wider font-bold transition-all border",
                  !isBuying
                    ? ""
                    : "text-muted hover:text-ink border-transparent",
                )}
                style={
                  !isBuying
                    ? {
                        backgroundColor: "rgba(225, 29, 72, 0.2)",
                        color: "#fb7185",
                        borderColor: "rgba(225, 29, 72, 0.4)",
                      }
                    : undefined
                }
              >
                Sell
              </button>
            </div>

            {/* Price input */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs uppercase tracking-[0.12em] text-faint">
                  {t("orderbook.price")}
                </span>
                <div className="flex items-center gap-2">
                  {bestBid !== null && (
                    <button
                      onClick={() =>
                        setLimitPrice(
                          (Math.round(bestBid * 1000) / 10).toString(),
                        )
                      }
                      className="font-mono text-[9px] text-muted hover:text-ink transition-colors duration-100"
                    >
                      Bid {fmtCents(bestBid)}
                    </button>
                  )}
                  {bestAsk !== null && (
                    <button
                      onClick={() =>
                        setLimitPrice(
                          (Math.round(bestAsk * 1000) / 10).toString(),
                        )
                      }
                      className="font-mono text-[9px] text-muted hover:text-ink transition-colors duration-100"
                    >
                      Ask {fmtCents(bestAsk)}
                    </button>
                  )}
                </div>
              </div>
              <div className="relative">
                <button
                  type="button"
                  onPointerDown={() => startHold(() => priceStep(-0.1))}
                  onPointerUp={stopHold}
                  onPointerLeave={stopHold}
                  onPointerCancel={stopHold}
                  className="absolute left-0 top-0 h-full px-3 flex items-center justify-center text-muted hover:text-ink transition-colors z-10 select-none"
                >
                  <span className="text-lg font-bold">−</span>
                </button>
                <input
                  data-testid="ob-price-input"
                  type="text"
                  inputMode="decimal"
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value)}
                  className="input-field px-10 py-3 text-xl font-bold text-center tabular-nums"
                />
                <button
                  type="button"
                  onPointerDown={() => startHold(() => priceStep(0.1))}
                  onPointerUp={stopHold}
                  onPointerLeave={stopHold}
                  onPointerCancel={stopHold}
                  className="absolute right-0 top-0 h-full px-3 flex items-center justify-center text-muted hover:text-ink transition-colors z-10 select-none"
                >
                  <span className="text-lg font-bold">+</span>
                </button>
              </div>
            </div>

            {/* Shares input — matches Trade page style with +/- buttons */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs uppercase tracking-[0.12em] text-faint">
                  {t("orderbook.shares")}
                </span>
                <button
                  onClick={() => {
                    if (isBuying) {
                      const max =
                        limitPriceNum > 0
                          ? Number(formatUnits(availableBalance, 18)) /
                            limitPriceNum
                          : 0;
                      setShares(Math.floor(max).toString());
                    } else {
                      setShares(
                        Math.floor(
                          parseFloat(formatUnits(relevantTokenBalance, 18)),
                        ).toString(),
                      );
                    }
                  }}
                  className="font-mono text-xs text-accent hover:text-accent uppercase tracking-[0.12em] transition-colors duration-100"
                >
                  MAX
                </button>
              </div>
              <div className="relative">
                <button
                  type="button"
                  onPointerDown={() => startHold(() => sharesStep(-1))}
                  onPointerUp={stopHold}
                  onPointerLeave={stopHold}
                  onPointerCancel={stopHold}
                  className="absolute left-0 top-0 h-full px-3 flex items-center justify-center text-muted hover:text-ink transition-colors z-10 select-none"
                >
                  <span className="text-lg font-bold">−</span>
                </button>
                <input
                  data-testid="ob-shares-input"
                  type="text"
                  inputMode="decimal"
                  placeholder="0"
                  value={shares}
                  onChange={(e) => setShares(e.target.value)}
                  className="input-field px-10 py-3 text-xl font-bold text-center tabular-nums"
                />
                <button
                  type="button"
                  onPointerDown={() => startHold(() => sharesStep(1))}
                  onPointerUp={stopHold}
                  onPointerLeave={stopHold}
                  onPointerCancel={stopHold}
                  className="absolute right-0 top-0 h-full px-3 flex items-center justify-center text-muted hover:text-ink transition-colors z-10 select-none"
                >
                  <span className="text-lg font-bold">+</span>
                </button>
              </div>
            </div>

            {/* Cost summary */}
            {sharesNum > 0 && (
              <div className="space-y-1 font-mono text-xs">
                <div className="flex justify-between">
                  <span className="text-muted">
                    {isBuying
                      ? t("orderbook.cost")
                      : t("orderbook.tokensBurned")}
                  </span>
                  <span className="text-ink tabular-nums">
                    {isBuying
                      ? fmtUsd(estimatedCost)
                      : `${sharesNum} ${isYes ? "YES" : "NO"}`}
                  </span>
                </div>
                {isBuying && (
                  <div className="flex justify-between">
                    <span className="text-faint">
                      {t("orderbook.payoutIfCorrect")}
                    </span>
                    <span className="text-muted tabular-nums">
                      {fmtUsd(payout)}
                    </span>
                  </div>
                )}
                {isBuying && estimatedCost > 0 && (
                  <div className="flex justify-between">
                    <span className="text-faint">{t("orderbook.return")}</span>
                    <span className="text-muted tabular-nums">
                      {((payout / estimatedCost - 1) * 100).toFixed(0)}%
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Sell mode hint */}
            {!isBuying && (
              <div className="font-mono text-xs text-muted px-3 py-2 border border-subtle bg-raised leading-relaxed">
                {`Burns ${isYes ? "YES" : "NO"} tokens. Fills auto-merge to USDC.`}
              </div>
            )}

            {validationError && (
              <div
                data-testid="ob-validation-error"
                className="font-mono text-xs text-neg px-3 py-2 border border-neg/40 bg-neg/10 leading-relaxed"
              >
                {validationError}
              </div>
            )}

            {/* CTA */}
            <button
              data-testid="ob-submit-button"
              onClick={handleSubmit}
              disabled={
                isPending ||
                sharesNum <= 0 ||
                insufficientBalance ||
                insufficientShares ||
                tickOutOfRange
              }
              className="btn btn-primary w-full py-4 font-mono text-xs uppercase tracking-[0.12em] font-bold flex items-center justify-center gap-2"
            >
              {isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  {ctaLabel}
                  {sharesNum > 0 && (
                    <span className="opacity-60 ml-1">
                      &mdash; {fmtUsd(estimatedCost)}
                    </span>
                  )}
                </>
              )}
            </button>
          </div>
          {/* end p-5 */}
        </div>
        {/* end bg-raised */}

        {/* Orders / Mint */}
        <div className="bg-raised flex flex-col">
          {/* Tab bar */}
          <div className="flex items-center gap-4 px-4 pt-3 border-b border-rule">
            {[
              { id: "orders" as const, label: t("orderbook.orders") },
              { id: "mint" as const, label: t("orderbook.mintMerge") },
            ].map((tab) => (
              <button
                key={tab.id}
                data-testid={`bottom-right-tab-${tab.id}`}
                onClick={() => setBottomRightTab(tab.id)}
                className={cn(
                  "pb-2 font-mono text-xs uppercase tracking-[0.12em] transition-colors duration-100 border-b-2 -mb-px",
                  bottomRightTab === tab.id
                    ? "text-ink border-accent"
                    : "text-faint border-transparent hover:text-muted",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0">
            {bottomRightTab === "orders" && (
              <div className="p-4">
                <UserOrdersPanel
                  marketAddress={marketAddress as `0x${string}`}
                  marketKey={marketKey}
                  soothBookAddress={resolvedSB}
                  isLoading={obLoading}
                  onRefresh={refetchOb}
                  chainId={chainId}
                  viewOutcome={viewOutcome}
                  onCancelOrder={cancelOrder}
                  onCancelOrders={cancelOrders}
                />
              </div>
            )}

            {bottomRightTab === "mint" && marketKey && (
              <div className="p-4">
                <MintMergePanel
                  marketAddress={marketAddress as Address}
                  marketKey={marketKey}
                  soothBookAddress={resolvedSB}
                />
              </div>
            )}

            {/* LiquidityMap moved to top-left quadrant */}
          </div>
        </div>
        {afterTradePane}
      </div>
      {/* end right column */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OBRow — single row in the 3-column orderbook
// ---------------------------------------------------------------------------

function OBRow({
  bid,
  ask,
  maxBidSize,
  maxAskSize,
  onClickBid,
  onClickAsk,
  midSlot,
}: {
  bid?: { displayPrice: string; amount: string };
  ask?: { displayPrice: string; amount: string };
  maxBidSize: number;
  maxAskSize: number;
  onClickBid?: () => void;
  onClickAsk?: () => void;
  midSlot?: React.ReactNode;
}) {
  const bidSize = bid ? parseFloat(bid.amount) : 0;
  const askSize = ask ? parseFloat(ask.amount) : 0;
  const bidPct = maxBidSize > 0 ? (bidSize / maxBidSize) * 100 : 0;
  const askPct = maxAskSize > 0 ? (askSize / maxAskSize) * 100 : 0;

  return (
    <>
      {/* Bid cell */}
      <div
        onClick={onClickBid}
        className={cn(
          "relative flex items-center justify-between px-3 py-[5px] overflow-hidden font-mono text-xs",
          bid
            ? "cursor-pointer hover:bg-raised transition-colors duration-100"
            : "",
        )}
      >
        {bid && (
          <div
            className="absolute right-0 top-0 bottom-0 transition-all"
            style={{
              width: `${bidPct}%`,
              backgroundColor:
                "color-mix(in srgb, var(--pos) 18%, transparent)",
            }}
          />
        )}
        <span className="relative text-muted tabular-nums">
          {bid ? Math.round(bidSize).toString() : ""}
        </span>
        <span className="relative text-ink tabular-nums font-medium">
          {bid ? fmtCents(parseFloat(bid.displayPrice)) : ""}
        </span>
      </div>

      {/* Mid column */}
      <div className="flex items-center justify-center border-x border-rule min-w-[72px]">
        {midSlot}
      </div>

      {/* Ask cell */}
      <div
        onClick={onClickAsk}
        className={cn(
          "relative flex items-center justify-between px-3 py-[5px] overflow-hidden font-mono text-xs",
          ask
            ? "cursor-pointer hover:bg-raised transition-colors duration-100"
            : "",
        )}
      >
        {ask && (
          <div
            className="absolute left-0 top-0 bottom-0 transition-all"
            style={{
              width: `${askPct}%`,
              backgroundColor:
                "color-mix(in srgb, var(--neg) 18%, transparent)",
            }}
          />
        )}
        <span className="relative text-muted tabular-nums font-medium">
          {ask ? fmtCents(parseFloat(ask.displayPrice)) : ""}
        </span>
        <span className="relative text-muted tabular-nums">
          {ask ? Math.round(askSize).toString() : ""}
        </span>
      </div>
    </>
  );
}

export default SoothBookTerminal;
