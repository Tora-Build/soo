import {
  type PointerEvent,
  type WheelEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { formatUnits } from "@/lib/chain-shim";

import { cn } from "../../../lib/utils";
import {
  CandleInterval,
  useSoothBookPriceHistory,
} from "../../../hooks/useSoothBookPriceHistory";

const INTERVALS: Array<{ label: string; value: CandleInterval }> = [
  { label: "5s", value: "5s" },
  { label: "1m", value: "1m" },
  { label: "15m", value: "15m" },
  { label: "1h", value: "1h" },
];

const CHART_TOP = 8;
const CHART_BOTTOM = 88;
const CHART_HEIGHT = CHART_BOTTOM - CHART_TOP;
const CHART_X_MIN = 0.8;
const CHART_X_MAX = 99.2;
const DEFAULT_VISIBLE_CANDLES = 120;
const MIN_VISIBLE_CANDLES = 2;
const ZOOM_FACTOR = 0.8;

export type HistoricalPriceCardProps = {
  chainId: number | undefined;
  marketKey: `0x${string}` | undefined;
  viewOutcome: "yes" | "no";
};

function formatAxisTime(timestamp: number, interval: CandleInterval): string {
  const date = new Date(timestamp * 1000);
  if (interval === "5s") {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
  if (interval === "1h") {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatCents(value: number): string {
  return `${value.toFixed(1)}¢`;
}

export function HistoricalPriceCard({
  chainId,
  marketKey,
  viewOutcome,
}: HistoricalPriceCardProps) {
  const clipId = useId().replace(/:/g, "");
  const [interval, setInterval] = useState<CandleInterval>("1m");
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE_CANDLES);
  const [panOffset, setPanOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragState = useRef<{ startX: number; startPan: number } | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);

  const { candles, isLoading } = useSoothBookPriceHistory(
    chainId,
    marketKey,
    interval,
  );

  useEffect(() => {
    setVisibleCount(DEFAULT_VISIBLE_CANDLES);
    setPanOffset(0);
  }, [interval, marketKey]);

  const displayCandles = useMemo(() => {
    if (viewOutcome === "yes") return candles;
    return candles.map((candle) => ({
      ...candle,
      open: 1 - candle.open,
      high: 1 - candle.low,
      low: 1 - candle.high,
      close: 1 - candle.close,
    }));
  }, [candles, viewOutcome]);

  const totalCandles = displayCandles.length;
  const minVisible =
    totalCandles > 0
      ? Math.min(MIN_VISIBLE_CANDLES, totalCandles)
      : MIN_VISIBLE_CANDLES;
  const boundedVisibleCount =
    totalCandles > 0
      ? clamp(Math.round(visibleCount), minVisible, totalCandles)
      : 0;
  const maxPanOffset = Math.max(0, totalCandles - boundedVisibleCount);
  const effectivePanOffset = clamp(panOffset, 0, maxPanOffset);

  const visibleCandles = useMemo(() => {
    if (totalCandles === 0 || boundedVisibleCount === 0) return [];
    const endExclusive = totalCandles - effectivePanOffset;
    const start = Math.max(0, endExclusive - boundedVisibleCount);
    return displayCandles.slice(start, endExclusive);
  }, [displayCandles, totalCandles, effectivePanOffset, boundedVisibleCount]);

  const series = visibleCandles.map((candle) =>
    clamp(candle.close * 100, 0, 100),
  );
  const yAxisLevels = [100, 75, 50, 25, 0];

  const scaleY = useMemo(
    () => (value: number) =>
      clamp(
        CHART_BOTTOM - (value / 100) * CHART_HEIGHT,
        CHART_TOP,
        CHART_BOTTOM,
      ),
    [],
  );

  const points = useMemo(() => {
    if (visibleCandles.length < 2) return [] as Array<{ x: number; y: number }>;

    const firstTs = visibleCandles[0].timestamp;
    const lastTs = visibleCandles[visibleCandles.length - 1].timestamp;
    const span = Math.max(1, lastTs - firstTs);
    const fallbackCount = Math.max(1, visibleCandles.length - 1);

    return visibleCandles.map((candle, index) => {
      const close = clamp(candle.close * 100, 0, 100);
      const timeLinearX =
        lastTs === firstTs
          ? (index / fallbackCount) * 100
          : ((candle.timestamp - firstTs) / span) * 100;
      const rawX = clamp(timeLinearX, 0, 100);
      const rawY = scaleY(close);
      const paddedX = CHART_X_MIN + (rawX / 100) * (CHART_X_MAX - CHART_X_MIN);

      return {
        x: paddedX,
        y: rawY,
      };
    });
  }, [scaleY, visibleCandles]);

  const linePath = useMemo(() => {
    if (points.length < 2) return "";
    return points
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
      )
      .join(" ");
  }, [points]);

  const yTicks = useMemo(
    () =>
      yAxisLevels.map((value, index) => ({
        value,
        y: CHART_TOP + (index / 4) * CHART_HEIGHT,
      })),
    [yAxisLevels],
  );

  const xTicks = useMemo(() => {
    if (visibleCandles.length < 2) return [] as string[];
    const first = visibleCandles[0].timestamp;
    const last = visibleCandles[visibleCandles.length - 1].timestamp;
    const middleTarget = first + (last - first) / 2;
    const middle = visibleCandles.reduce((nearest, candle) => {
      const currentDistance = Math.abs(candle.timestamp - middleTarget);
      const bestDistance = Math.abs(nearest - middleTarget);
      return currentDistance < bestDistance ? candle.timestamp : nearest;
    }, first);

    return [
      formatAxisTime(first, interval),
      formatAxisTime(middle, interval),
      formatAxisTime(last, interval),
    ];
  }, [visibleCandles, interval]);
  const latestPoint = points.length > 0 ? points[points.length - 1] : null;
  const isLiveWindow = effectivePanOffset === 0;
  const nowMarker = useMemo(() => {
    if (!latestPoint || !isLiveWindow) return null;
    return {
      x: latestPoint.x,
      y: latestPoint.y,
    };
  }, [latestPoint, isLiveWindow]);

  const firstVisible = visibleCandles[0];
  const lastVisible = visibleCandles[visibleCandles.length - 1];
  const priceDelta =
    firstVisible && lastVisible ? lastVisible.close - firstVisible.close : 0;
  const changePctDisplay =
    firstVisible && firstVisible.close > 0
      ? (priceDelta / firstVisible.close) * 100
      : 0;
  const deltaDisplay = priceDelta * 100;
  const lastDisplay = lastVisible ? lastVisible.close * 100 : null;
  const displayHigh =
    visibleCandles.length > 0
      ? Math.max(...visibleCandles.map((candle) => candle.high)) * 100
      : null;
  const displayLow =
    visibleCandles.length > 0
      ? Math.min(...visibleCandles.map((candle) => candle.low)) * 100
      : null;
  const totalVolumeShares = Number(
    formatUnits(
      visibleCandles.reduce((sum, candle) => sum + candle.volume, 0n),
      18,
    ),
  );
  const totalTrades = visibleCandles.reduce(
    (sum, candle) => sum + candle.trades,
    0,
  );

  const canZoomIn =
    totalCandles > minVisible && boundedVisibleCount > minVisible;
  const canZoomOut =
    boundedVisibleCount > 0 && boundedVisibleCount < totalCandles;
  const canPan = maxPanOffset > 0;

  const setVisibleCountSafe = (nextCount: number) => {
    if (totalCandles === 0) return;
    const next = clamp(Math.round(nextCount), minVisible, totalCandles);
    setVisibleCount(next);
    setPanOffset((prev) => clamp(prev, 0, Math.max(0, totalCandles - next)));
  };

  const handleZoomIn = () =>
    setVisibleCountSafe(boundedVisibleCount * ZOOM_FACTOR);
  const handleZoomOut = () =>
    setVisibleCountSafe(boundedVisibleCount / ZOOM_FACTOR);
  const handleResetView = () => {
    if (totalCandles === 0) return;
    const reset = Math.min(DEFAULT_VISIBLE_CANDLES, totalCandles);
    setVisibleCount(reset);
    setPanOffset(0);
  };

  const panBy = (deltaCandles: number) => {
    if (!canPan || deltaCandles === 0) return;
    setPanOffset((prev) => clamp(prev + deltaCandles, 0, maxPanOffset));
  };

  const handleChartWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (totalCandles < 2) return;

    event.preventDefault();
    const absY = Math.abs(event.deltaY);
    const absX = Math.abs(event.deltaX);

    if (absY >= absX) {
      if (event.deltaY < 0) {
        handleZoomIn();
      } else {
        handleZoomOut();
      }
      return;
    }

    const panStep = Math.max(1, Math.round(boundedVisibleCount * 0.06));
    panBy(event.deltaX > 0 ? panStep : -panStep);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!canPan) return;
    dragState.current = { startX: event.clientX, startPan: effectivePanOffset };
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !dragState.current || !canPan) return;

    const width = plotRef.current?.clientWidth ?? 0;
    if (width <= 0) return;

    const deltaX = event.clientX - dragState.current.startX;
    const candlesPerPixel = boundedVisibleCount / width;
    const deltaCandles = Math.round(-deltaX * candlesPerPixel);
    const nextPan = clamp(
      dragState.current.startPan + deltaCandles,
      0,
      maxPanOffset,
    );
    setPanOffset(nextPan);
  };

  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    dragState.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="bg-raised overflow-hidden">
      <div className="px-4 py-3 border-b border-rule/50 flex items-center justify-between gap-2">
        <span className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
          Price History
        </span>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-raised p-0.5">
            {INTERVALS.map((item) => (
              <button
                key={item.value}
                onClick={() => setInterval(item.value)}
                className={cn(
                  "px-2 py-1 text-xs font-bold transition-colors",
                  interval === item.value
                    ? "bg-raised text-ink"
                    : "text-muted hover:text-ink",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 bg-raised p-0.5">
            <button
              onClick={handleZoomOut}
              disabled={!canZoomOut}
              className={cn(
                "w-6 h-6 inline-flex items-center justify-center transition-colors",
                canZoomOut
                  ? "text-ink hover:bg-raised"
                  : "text-faint cursor-not-allowed",
              )}
              title="Zoom out"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleZoomIn}
              disabled={!canZoomIn}
              className={cn(
                "w-6 h-6 inline-flex items-center justify-center transition-colors",
                canZoomIn
                  ? "text-ink hover:bg-raised"
                  : "text-faint cursor-not-allowed",
              )}
              title="Zoom in"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleResetView}
              disabled={
                totalCandles === 0 ||
                (effectivePanOffset === 0 &&
                  boundedVisibleCount ===
                    Math.min(
                      DEFAULT_VISIBLE_CANDLES,
                      totalCandles || DEFAULT_VISIBLE_CANDLES,
                    ))
              }
              className={cn(
                "w-6 h-6 inline-flex items-center justify-center transition-colors",
                totalCandles > 0
                  ? "text-ink hover:bg-raised"
                  : "text-faint cursor-not-allowed",
              )}
              title="Reset view"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div className="p-4 space-y-3">
        {isLoading ? (
          <div className="h-20 bg-raised" />
        ) : series.length < 2 ? (
          <div className="h-20 bg-raised flex items-center justify-center text-xs text-muted">
            Not enough fills yet for historical chart
          </div>
        ) : (
          <>
            <div className="h-44 bg-inset p-3 overflow-hidden">
              <div className="grid grid-cols-[44px_1fr] gap-2 h-full">
                <div className="flex flex-col justify-between text-xs text-muted py-1">
                  {yTicks.map((tick, i) => (
                    <span
                      key={`${tick.value}-${i}`}
                      className="font-mono leading-none"
                    >
                      {tick.value.toFixed(0)}%
                    </span>
                  ))}
                </div>
                <div className="h-full flex flex-col min-h-0">
                  <div
                    ref={plotRef}
                    className={cn(
                      "relative flex-1 min-h-0 overflow-hidden",
                      canPan
                        ? isDragging
                          ? "cursor-grabbing"
                          : "cursor-grab"
                        : "cursor-default",
                    )}
                    onWheel={handleChartWheel}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={stopDragging}
                    onPointerCancel={stopDragging}
                    onPointerLeave={stopDragging}
                  >
                    <svg
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                      className="w-full h-full"
                    >
                      <defs>
                        <clipPath id={clipId}>
                          <rect x="0" y="0" width="100" height="100" />
                        </clipPath>
                      </defs>

                      {yTicks.map((tick, i) => (
                        <line
                          key={`grid-${i}`}
                          x1="0"
                          y1={tick.y}
                          x2="100"
                          y2={tick.y}
                          stroke="rgba(100,116,139,0.22)"
                          strokeWidth="0.6"
                          strokeDasharray={tick.value === 50 ? "0" : "2 2"}
                        />
                      ))}

                      {[25, 50, 75].map((x) => (
                        <line
                          key={`x-grid-${x}`}
                          x1={x}
                          y1={CHART_TOP}
                          x2={x}
                          y2={CHART_BOTTOM}
                          stroke="rgba(71,85,105,0.18)"
                          strokeWidth="0.5"
                        />
                      ))}

                      {linePath && (
                        <path
                          d={linePath}
                          fill="none"
                          stroke="var(--accent)"
                          strokeWidth="1.2"
                          strokeLinecap="butt"
                          strokeLinejoin="round"
                          clipPath={`url(#${clipId})`}
                          vectorEffect="non-scaling-stroke"
                          shapeRendering="geometricPrecision"
                        />
                      )}
                    </svg>
                    {nowMarker && (
                      <div
                        className="absolute pointer-events-none z-10"
                        style={{
                          left: `${nowMarker.x}%`,
                          top: `${nowMarker.y}%`,
                          transform: "translate(-50%, -50%)",
                        }}
                      >
                        <span className="absolute -inset-1 rounded-full bg-accent-muted animate-ping" />
                        <span className="block w-2 h-2 rounded-full bg-accent" />
                      </div>
                    )}
                  </div>

                  <div className="mt-1 flex items-center justify-between text-xs text-muted font-mono leading-none">
                    {xTicks.length === 3 ? (
                      <>
                        <span>{xTicks[0]}</span>
                        <span>{xTicks[1]}</span>
                        <span>{xTicks[2]}</span>
                      </>
                    ) : (
                      <>
                        <span>—</span>
                        <span>—</span>
                        <span>—</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between text-xs text-muted font-mono px-1">
              <span>
                Showing {visibleCandles.length} / {totalCandles} candles
              </span>
              <span>
                {canPan ? "Scroll to zoom · Drag to pan" : "Scroll to zoom"}
              </span>
            </div>
          </>
        )}

        <div className="flex items-center gap-4 text-xs overflow-x-auto whitespace-nowrap pb-1">
          <div className="inline-flex items-baseline gap-1 shrink-0">
            <span className="text-muted">Last</span>
            <span className="font-mono text-ink">
              {lastDisplay !== null ? formatCents(lastDisplay) : "—"}
            </span>
          </div>
          <div className="inline-flex items-baseline gap-1 shrink-0">
            <span className="text-muted">Change</span>
            <span className="font-mono text-ink">
              {deltaDisplay >= 0 ? "+" : "-"}
              {formatCents(Math.abs(deltaDisplay))}
            </span>
          </div>
          <div className="inline-flex items-baseline gap-1 shrink-0">
            <span className="text-muted">High</span>
            <span className="font-mono text-ink">
              {displayHigh !== null ? formatCents(displayHigh) : "—"}
            </span>
          </div>
          <div className="inline-flex items-baseline gap-1 shrink-0">
            <span className="text-muted">Low</span>
            <span className="font-mono text-ink">
              {displayLow !== null ? formatCents(displayLow) : "—"}
            </span>
          </div>
          <div className="inline-flex items-baseline gap-1 shrink-0">
            <span className="text-muted">Volume</span>
            <span className="font-mono text-ink">
              {totalVolumeShares.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
