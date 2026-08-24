/**
 * LiquidityMap - Visual liquidity depth chart for SoothBook orderbook
 *
 * Shows bid/ask liquidity distribution across price ticks with
 * animated pixel blocks. Displays current price indicators for
 * both AMM and SoothBook prices.
 */
import { useMemo, useRef, useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { formatUnits, parseUnits } from "@/lib/chain-shim";
import { cn } from "../../../lib/utils";

// ============================================================================
// Types
// ============================================================================
export interface TickData {
  tick: number;
  liquidity: bigint;
}

export interface V12Order {
  id: string;
  yesPrice: string;
  amount: string;
  side: "bid" | "ask";
}

export interface LiquidityMapProps {
  bids?: V12Order[];
  asks?: V12Order[];
  currentProb: number;
  ammProb: number;
  isLoading: boolean;
  viewOutcome: "yes" | "no";
}

// ============================================================================
// Component
// ============================================================================
export const LiquidityMap = ({
  bids,
  asks,
  currentProb,
  ammProb,
  isLoading,
  viewOutcome,
}: LiquidityMapProps) => {
  const NUM_BUCKETS = 150;
  const GAP_PX = 2;
  const chartRef = useRef<HTMLDivElement>(null);
  const [maxBlocks, setMaxBlocks] = useState(12);

  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    const measure = () => {
      const { height, width } = el.getBoundingClientRect();
      const innerH = height - 16;
      const innerW = width - 16 - 32;
      const colW = Math.max(1, (innerW - (NUM_BUCKETS - 1)) / NUM_BUCKETS);
      setMaxBlocks(
        Math.max(4, Math.floor((innerH + GAP_PX) / (colW + GAP_PX))),
      );
    };
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const MAX_BLOCKS = maxBlocks;
  // Build liquidity buckets for visualization (150 columns for slightly larger squares)
  const {
    buckets,
    totalLiquidity,
    maxBucketLiquidity,
    bestBuyBoundary,
    bestSellBoundary,
  } = useMemo(() => {
    const numBuckets = NUM_BUCKETS;
    const bucketData: { price: number; yesLiq: bigint; noLiq: bigint }[] = [];

    // Initialize empty buckets
    for (let i = 0; i < numBuckets; i++) {
      bucketData.push({
        price: ((i + 1) * 100) / numBuckets, // 1.25% to 100% (synthetic, for fallback)
        yesLiq: 0n,
        noLiq: 0n,
      });
    }

    let totalLiq = 0n;
    let bestBuyBoundary = 0;
    let bestSellBoundary = 100;
    let hasBuyBoundary = false;
    let hasSellBoundary = false;

    const allLevels = [...(bids ?? []), ...(asks ?? [])];
    for (const level of allLevels) {
      const yesPrice = Number(level.yesPrice);
      if (!Number.isFinite(yesPrice)) continue;
      const pricePercent = yesPrice * 100;
      if (pricePercent < 0 || pricePercent > 100) continue;

      let amountWad = 0n;
      try {
        amountWad = parseUnits(level.amount || "0", 18);
      } catch {
        amountWad = 0n;
      }
      if (amountWad <= 0n) continue;

      const bucketIndex = Math.max(
        0,
        Math.min(numBuckets - 1, Math.floor((pricePercent / 100) * numBuckets)),
      );
      if (level.side === "bid") {
        bucketData[bucketIndex].yesLiq += amountWad;
      } else {
        bucketData[bucketIndex].noLiq += amountWad;
      }

      totalLiq += amountWad;
      if (level.side === "bid") {
        bestBuyBoundary = Math.max(bestBuyBoundary, pricePercent);
        hasBuyBoundary = true;
      } else {
        bestSellBoundary = Math.min(bestSellBoundary, pricePercent);
        hasSellBoundary = true;
      }
    }

    if (totalLiq === 0n) {
      bestBuyBoundary = 0;
      bestSellBoundary = 100;
      hasBuyBoundary = false;
      hasSellBoundary = false;
    }

    const buckets = bucketData.map((b) => ({
      price: b.price,
      yesLiq: b.yesLiq,
      noLiq: b.noLiq,
      liquidity: b.yesLiq + b.noLiq,
    }));

    let maxBucketLiq = 0n;
    for (const b of buckets) {
      if (b.liquidity > maxBucketLiq) maxBucketLiq = b.liquidity;
    }

    return {
      buckets,
      totalLiquidity: totalLiq,
      maxBucketLiquidity: maxBucketLiq,
      bestBuyBoundary: hasBuyBoundary ? bestBuyBoundary : null,
      bestSellBoundary: hasSellBoundary ? bestSellBoundary : null,
    };
  }, [asks, bids]);

  // Dynamic scale: blockUnit adapts so the tallest column fills MAX_BLOCKS
  const blockUnit =
    maxBucketLiquidity > 0n
      ? (maxBucketLiquidity + BigInt(MAX_BLOCKS) - 1n) / BigInt(MAX_BLOCKS) // ceiling division
      : parseUnits("20", 18); // fallback when no data
  const scaleMax = blockUnit * BigInt(MAX_BLOCKS);

  const displayBuckets = useMemo(() => {
    if (viewOutcome === "yes") return buckets;
    return [...buckets].reverse().map((b) => ({
      ...b,
      yesLiq: b.noLiq,
      noLiq: b.yesLiq,
      price: 100 - b.price,
    }));
  }, [buckets, viewOutcome]);

  const displayProb = viewOutcome === "yes" ? currentProb : 1 - currentProb;
  const displayAmmProb = viewOutcome === "yes" ? ammProb : 1 - ammProb;
  const hasRealData = (bids?.length ?? 0) > 0 || (asks?.length ?? 0) > 0;
  const hasAnyData = hasRealData;
  const displayBestBuy = hasRealData
    ? viewOutcome === "yes"
      ? bestBuyBoundary
      : bestSellBoundary !== null
        ? 100 - bestSellBoundary
        : null
    : null;
  const displayBestSell = hasRealData
    ? viewOutcome === "yes"
      ? bestSellBoundary
      : bestBuyBoundary !== null
        ? 100 - bestBuyBoundary
        : null
    : null;

  return (
    <div className="relative min-h-[120px]">
      {/* Price scale */}
      <div className="flex justify-between text-xs text-faint font-mono mb-1 px-1">
        <span>0%</span>
        <span>25%</span>
        <span>50%</span>
        <span>75%</span>
        <span>100%</span>
      </div>

      {/* Pixel depth chart */}
      <div
        ref={chartRef}
        className="relative h-32 flex items-end gap-0 bg-inset p-2"
      >
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-6 h-6 text-muted animate-spin" />
          </div>
        ) : !hasAnyData ? (
          // No liquidity - simple empty state
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-sm text-muted">No orders yet</span>
          </div>
        ) : null}

        {!isLoading && displayProb > 0 && displayProb < 1 && (
          <div
            className="absolute top-0 bottom-0 w-[1.5px] bg-accent z-20 pointer-events-none"
            style={{ left: `calc(${displayProb * 100}% - 0.75px)` }}
          />
        )}

        {/* Y-Axis Depth Scale */}
        <div className="absolute left-0 top-2 bottom-3 flex flex-col justify-between items-end pr-1 border-r border-rule/50 pointer-events-none z-20 w-8">
          <div className="text-[10px] text-muted font-mono flex items-center gap-1">
            {totalLiquidity > 0n
              ? parseFloat(formatUnits(scaleMax, 18)).toFixed(0)
              : "0"}
            <div className="w-1.5 h-[1px] bg-raised" />
          </div>
          <div className="text-[10px] text-muted font-mono flex items-center gap-1">
            {totalLiquidity > 0n
              ? parseFloat(formatUnits(scaleMax / 2n, 18)).toFixed(0)
              : "0"}
            <div className="w-1.5 h-[1px] bg-raised" />
          </div>
          <div className="text-[10px] text-muted font-mono flex items-center gap-1">
            0
            <div className="w-1.5 h-[1px] bg-raised" />
          </div>
        </div>

        {!isLoading && hasAnyData && (
          <div className="flex-1 h-full flex items-end gap-[1px] pl-8">
            {displayBuckets.map((bucket, col) => {
              const hasLiquidity = bucket.liquidity > 0n;
              const totalBlocks =
                bucket.liquidity > 0n
                  ? Math.max(
                      1,
                      Math.min(
                        MAX_BLOCKS,
                        Number((bucket.liquidity + blockUnit - 1n) / blockUnit),
                      ),
                    )
                  : 0;
              let greenBlocks = 0;
              let redBlocks = 0;
              if (hasLiquidity && totalBlocks > 0) {
                greenBlocks = Number(
                  (bucket.yesLiq * BigInt(totalBlocks)) /
                    (bucket.liquidity || 1n),
                );
                redBlocks = totalBlocks - greenBlocks;
                if (bucket.yesLiq > 0n && greenBlocks === 0) {
                  greenBlocks = 1;
                  redBlocks = Math.max(0, totalBlocks - 1);
                }
                if (bucket.noLiq > 0n && redBlocks === 0) {
                  redBlocks = 1;
                  greenBlocks = Math.max(0, totalBlocks - 1);
                }
              }

              return (
                <div
                  key={col}
                  className={cn(
                    "flex-1 flex flex-col justify-end gap-[2px] relative group h-full",
                    hasLiquidity && "cursor-pointer",
                  )}
                >
                  {hasLiquidity &&
                    (() => {
                      const isBuySide = bucket.yesLiq > 0n;
                      const liq = isBuySide ? bucket.yesLiq : bucket.noLiq;
                      const val = Number(formatUnits(liq, 18));
                      const formatted =
                        val === 0 && liq > 0n
                          ? "< 0.0001"
                          : val < 0.1
                            ? val.toFixed(4)
                            : val.toLocaleString(undefined, {
                                maximumFractionDigits: 1,
                              });
                      return (
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 opacity-0 group-hover:opacity-100 transition-opacity z-[9999] pointer-events-none">
                          <div className="bg-tooltip border border-rule px-3 py-2 text-center">
                            <div className="font-mono font-bold text-ink text-xs mb-1">
                              {bucket.price.toFixed(1)}%
                            </div>
                            <div
                              className={cn(
                                "text-xs font-bold whitespace-nowrap",
                                isBuySide ? "text-pos" : "text-neg",
                              )}
                            >
                              {isBuySide ? "Buy" : "Sell"} {formatted}{" "}
                              {viewOutcome.toUpperCase()}
                            </div>
                            <div className="text-[10px] text-muted mt-1 uppercase tracking-tighter">
                              {(
                                (bucket.liquidity * 100n) /
                                (totalLiquidity || 1n)
                              ).toString()}
                              % of Depth
                            </div>
                          </div>
                          <div className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-[6px] border-r-[6px] border-t-[6px] border-transparent border-t-border" />
                        </div>
                      );
                    })()}

                  {hasLiquidity &&
                    [...Array(redBlocks)].map((_, blockIdx) => {
                      // 25–80% opacity scale so stacked pixels read progressively
                      // from faint-to-dense depth. Was collapsed to a tautological
                      // ternary (all three branches picked bg-neg-soft = 10%),
                      // which made the map unreadable on the canvas bg.
                      const intensity = (blockIdx + 1) / Math.max(1, redBlocks);
                      const pct = Math.round(25 + intensity * 55);
                      return (
                        <div
                          key={`r-${blockIdx}`}
                          className={cn(
                            "w-full aspect-square transition-all duration-200",
                            "group-hover:ring-1 group-hover:ring-rule",
                            "group-hover:scale-110",
                          )}
                          style={{
                            backgroundColor: `color-mix(in srgb, var(--neg) ${pct}%, transparent)`,
                          }}
                        />
                      );
                    })}
                  {hasLiquidity &&
                    [...Array(greenBlocks)].map((_, blockIdx) => {
                      const intensity =
                        (blockIdx + 1) / Math.max(1, greenBlocks);
                      const pct = Math.round(25 + intensity * 55);
                      return (
                        <div
                          key={`g-${blockIdx}`}
                          className={cn(
                            "w-full aspect-square transition-all duration-200",
                            "group-hover:ring-1 group-hover:ring-rule",
                            "group-hover:scale-110",
                          )}
                          style={{
                            backgroundColor: `color-mix(in srgb, var(--pos) ${pct}%, transparent)`,
                          }}
                        />
                      );
                    })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mt-2 text-xs">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1">
            <span className="text-muted">AMM</span>
            <span className="font-mono text-ink">
              {(displayAmmProb * 100).toFixed(1)}¢
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted">DIFF</span>
            <span
              className={cn(
                "font-mono",
                hasRealData && Math.abs(displayProb - displayAmmProb) * 100 > 2
                  ? "text-accent"
                  : "text-muted",
              )}
            >
              {hasRealData
                ? `${(Math.abs(displayProb - displayAmmProb) * 100).toFixed(1)}¢`
                : "—"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1">
            <span className="text-muted">Best Buy</span>
            <span className="font-mono text-ink">
              {displayBestBuy !== null ? `${displayBestBuy.toFixed(1)}¢` : "—"}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted">Best Sell</span>
            <span className="font-mono text-ink">
              {displayBestSell !== null
                ? `${displayBestSell.toFixed(1)}¢`
                : "—"}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted">Liq</span>
            <span className="font-mono text-accent">
              {parseFloat(formatUnits(totalLiquidity, 18)).toLocaleString(
                undefined,
                { maximumFractionDigits: 0 },
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LiquidityMap;
