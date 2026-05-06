/**
 * EventChartCard — multi-outcome event card with integrated price chart.
 *
 * Polymarket-style: header → multi-line chart → outcome rows (legend +
 * click target) → footer with aggregate stats. Each outcome gets a
 * color from a fixed palette; the same color is used for both the chart
 * line and the row dot.
 *
 * Replaces the old EventCard (sibling list view) on AMM/Orderbook pages
 * and is reused by the Markets page event group rendering.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Layers, Clock, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CategoryBadge } from "../../ui/CategoryBadge";
import { useAmmMarketDirect } from "../../../hooks/useAmmMarketDirect";
import {
  useEventPriceHistory,
  type EventPriceSeries,
} from "../../../hooks/useEventPriceHistory";
import { cn } from "../../../lib/utils";

// Distinct line colors per outcome (rotates if >5 markets)
const OUTCOME_COLORS = [
  "var(--accent)", // brand gold
  "#34d399", // emerald
  "#60a5fa", // sky
  "#f472b6", // pink
  "#a78bfa", // purple
  "#fb923c", // orange
  "#22d3ee", // cyan
];

export interface EventChartMarket {
  address: string;
  question: string;
  category?: string;
  deadline?: number;
  bCurrent?: bigint;
  creator?: string;
}

interface EventChartCardProps {
  event: string;
  category?: string;
  chainId: number;
  markets: EventChartMarket[];
  currentAddress?: string; // highlight in row list
  basePath?: string; // "/amm" | "/orderbook"
  className?: string;
  /** When provided, clicking an outcome row calls this callback instead of
   *  navigating via React Router. Used inside QuickTrade modal so the
   *  click switches the loaded market in place. */
  onMarketClick?: (address: string) => void;
}

// ─── SVG chart ──────────────────────────────────────────────────────────
const CHART_WIDTH = 600;
const CHART_HEIGHT = 140;
const PADDING_LEFT = 28;
const PADDING_RIGHT = 8;
const PADDING_TOP = 8;
const PADDING_BOTTOM = 18;

interface ChartProps {
  series: EventPriceSeries[];
  // Current yes price per market (for flat-line fallback when no history)
  currentPriceByAddress: Map<string, number>;
  // createdAt timestamps per market (for flat-line start)
  createdAtByAddress: Map<string, number>;
}

const PriceChartSvg = ({
  series,
  currentPriceByAddress,
  createdAtByAddress,
}: ChartProps) => {
  // Compute time range across all series + current time
  const now = Math.floor(Date.now() / 1000);
  const allTimestamps: number[] = [];
  for (const s of series) {
    for (const p of s.points) allTimestamps.push(p.timestamp);
    const created = createdAtByAddress.get(s.market.toLowerCase());
    if (created && created > 0) allTimestamps.push(created);
  }
  if (allTimestamps.length === 0) allTimestamps.push(now - 3600, now);
  const minTs = Math.min(...allTimestamps);
  const maxTs = Math.max(now, ...allTimestamps);
  const tsRange = Math.max(1, maxTs - minTs);

  const innerW = CHART_WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const innerH = CHART_HEIGHT - PADDING_TOP - PADDING_BOTTOM;

  const xFor = (ts: number) => PADDING_LEFT + ((ts - minTs) / tsRange) * innerW;
  const yFor = (price: number) => PADDING_TOP + (1 - price) * innerH;

  // Build polyline points per market. If no history, draw flat line at
  // current price from createdAt (or minTs) to now.
  const lines = series.map((s, i) => {
    const color = OUTCOME_COLORS[i % OUTCOME_COLORS.length];
    let pts: { ts: number; price: number }[];
    if (s.points.length >= 2) {
      pts = s.points.map((p) => ({ ts: p.timestamp, price: p.price }));
      // Extend the last point to "now" so the line reaches the right edge
      const last = pts[pts.length - 1];
      if (last.ts < now) pts.push({ ts: now, price: last.price });
    } else {
      const current = currentPriceByAddress.get(s.market.toLowerCase()) ?? 0.5;
      const start = createdAtByAddress.get(s.market.toLowerCase()) || minTs;
      pts = [
        { ts: start, price: current },
        { ts: now, price: current },
      ];
    }
    const path = pts.map((p) => `${xFor(p.ts)},${yFor(p.price)}`).join(" ");
    return { color, path, market: s.market };
  });

  // Format axis ticks
  const fmtTime = (ts: number): string => {
    const d = new Date(ts * 1000);
    if (tsRange > 3 * 86400) {
      return d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    }
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <svg
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      preserveAspectRatio="none"
      className="w-full h-32"
    >
      {/* Y-axis grid + labels */}
      {[0, 0.25, 0.5, 0.75, 1].map((p) => {
        const y = yFor(p);
        return (
          <g key={p}>
            <line
              x1={PADDING_LEFT}
              x2={CHART_WIDTH - PADDING_RIGHT}
              y1={y}
              y2={y}
              stroke="currentColor"
              strokeOpacity={0.08}
              strokeWidth={1}
            />
            <text
              x={PADDING_LEFT - 4}
              y={y + 3}
              fontSize="9"
              textAnchor="end"
              fill="currentColor"
              fillOpacity={0.4}
              fontFamily="ui-monospace, monospace"
            >
              {(p * 100).toFixed(0)}%
            </text>
          </g>
        );
      })}

      {/* X-axis ticks (3) */}
      {[0, 0.5, 1].map((frac) => {
        const ts = minTs + frac * tsRange;
        return (
          <text
            key={frac}
            x={PADDING_LEFT + frac * innerW}
            y={CHART_HEIGHT - 4}
            fontSize="9"
            textAnchor={frac === 0 ? "start" : frac === 1 ? "end" : "middle"}
            fill="currentColor"
            fillOpacity={0.4}
            fontFamily="ui-monospace, monospace"
          >
            {fmtTime(ts)}
          </text>
        );
      })}

      {/* Lines */}
      {lines.map((l, i) => (
        <polyline
          key={l.market}
          points={l.path}
          fill="none"
          stroke={l.color}
          strokeWidth={1.6}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          opacity={0.9}
        />
      ))}
    </svg>
  );
};

// ─── Outcome row ───────────────────────────────────────────────────────
const OutcomeRow = ({
  market,
  color,
  isCurrent,
  basePath,
  onMarketClick,
}: {
  market: EventChartMarket;
  color: string;
  isCurrent: boolean;
  basePath: string;
  onMarketClick?: (address: string) => void;
}) => {
  const { amm } = useAmmMarketDirect(market.address as `0x${string}`);
  const yesPrice = amm?.yesProbability ?? 0.5;

  const rowClass = cn(
    "group/row flex items-center gap-3 pr-4 py-2 transition-colors",
    isCurrent
      ? "bg-accent/10 border-l-2 border-accent pl-[14px]"
      : "hover:bg-inset pl-4",
  );

  const inner = (
    <>
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: color }}
      />
      <span
        className={cn(
          "flex-1 text-xs leading-snug line-clamp-1 transition-colors",
          isCurrent
            ? "text-ink font-medium"
            : "text-muted group-hover/row:text-ink",
        )}
      >
        {market.question}
      </span>
      <div className="w-20 h-1 bg-inset overflow-hidden flex shrink-0">
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${yesPrice * 100}%`, backgroundColor: color }}
        />
        <div
          className="h-full bg-raised/40"
          style={{ width: `${(1 - yesPrice) * 100}%` }}
        />
      </div>
      <span className="font-mono text-sm font-bold tabular-nums w-10 text-right shrink-0 text-ink">
        {(yesPrice * 100).toFixed(0)}%
      </span>
    </>
  );

  if (onMarketClick) {
    return (
      <button
        type="button"
        onClick={() => onMarketClick(market.address)}
        className={cn(rowClass, "text-left w-full")}
      >
        {inner}
      </button>
    );
  }

  return (
    <Link to={`${basePath}/${market.address}`} className={rowClass}>
      {inner}
    </Link>
  );
};

// ─── Helpers for current prices (parent collects via children since
// we can't call hooks in a loop here directly) ─────────────────────────
const PriceProbe = ({
  address,
  onPrice,
}: {
  address: string;
  onPrice: (addr: string, price: number) => void;
}) => {
  const { amm } = useAmmMarketDirect(address as `0x${string}`);
  const price = amm?.yesProbability ?? 0.5;
  // Defer to parent state via callback once
  if (typeof window !== "undefined") {
    onPrice(address.toLowerCase(), price);
  }
  return null;
};

// ─── Main component ────────────────────────────────────────────────────
export const EventChartCard = ({
  event,
  category,
  chainId,
  markets,
  currentAddress,
  basePath = "/amm",
  className,
  onMarketClick,
}: EventChartCardProps) => {
  const { t, i18n } = useTranslation();
  const isSingleMarket = markets.length === 1;
  const addresses = useMemo(() => markets.map((m) => m.address), [markets]);
  const { series, isLoading, totalPoints } = useEventPriceHistory(
    chainId,
    addresses,
  );

  // For flat-line fallback we need current price + createdAt per market.
  // Current prices come from a Map populated by tiny <PriceProbe>s
  // mounted alongside the chart (one per market).
  const currentPriceByAddress = useMemo(() => new Map<string, number>(), []);
  const createdAtByAddress = useMemo(() => {
    const m = new Map<string, number>();
    // We don't have createdAt in EventChartMarket — fall back to "now − 6h"
    // when missing so the flat line at least spans something visible.
    const fallback = Math.floor(Date.now() / 1000) - 6 * 3600;
    for (const market of markets) {
      m.set(market.address.toLowerCase(), fallback);
    }
    return m;
  }, [markets]);

  // Aggregate stats
  const totalDepth = markets.reduce(
    (sum, m) => sum + Number((m.bCurrent ?? 0n) / 10n ** 18n),
    0,
  );
  const earliestDeadline = markets
    .map((m) => m.deadline)
    .filter((d): d is number => !!d && d > 0 && d < 4102444800)
    .sort((a, b) => a - b)[0];
  const earliestDeadlineStr = earliestDeadline
    ? new Date(earliestDeadline * 1000).toLocaleDateString(
        i18n.language === "zh" ? "zh-CN" : "en-US",
        {
        month: "short",
        day: "numeric",
        year: "numeric",
        },
      )
    : null;

  return (
    <div
      className={cn(
        "bg-raised border border-rule hover:border-accent/40 transition-colors",
        className,
      )}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-rule flex items-center justify-between gap-3">
        {isSingleMarket ? (
          <span className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
            {t("eventChart.ammPriceHistory")}
          </span>
        ) : (
          <>
            <div className="flex items-center gap-2 min-w-0">
              <Layers className="w-3.5 h-3.5 text-accent shrink-0" />
              <span className="font-mono text-xs uppercase tracking-[0.12em] text-accent font-bold truncate">
                {event}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint shrink-0">
                {t("marketsPage.outcomesCount", { count: markets.length })}
              </span>
            </div>
            {category && (
              <span className="shrink-0">
                <CategoryBadge category={category} />
              </span>
            )}
          </>
        )}
      </div>

      {/* Chart */}
      <div className="px-2 py-3 border-b border-rule text-ink">
        {isLoading && totalPoints === 0 ? (
          <div className="h-32 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
            {t("common.loading")}
          </div>
        ) : (
          <PriceChartSvg
            series={series}
            currentPriceByAddress={currentPriceByAddress}
            createdAtByAddress={createdAtByAddress}
          />
        )}
        {/* Hidden price probes — populate currentPriceByAddress map so the
            flat-line fallback uses the live price */}
        {markets.map((m) => (
          <PriceProbe
            key={m.address}
            address={m.address}
            onPrice={(addr, p) => currentPriceByAddress.set(addr, p)}
          />
        ))}
      </div>

      {/* Outcome rows (legend + click targets) — multi-market only */}
      {!isSingleMarket && (
        <div>
          {markets.map((m, i) => (
            <OutcomeRow
              key={m.address}
              market={m}
              color={OUTCOME_COLORS[i % OUTCOME_COLORS.length]}
              isCurrent={
                !!currentAddress &&
                m.address.toLowerCase() === currentAddress.toLowerCase()
              }
              basePath={basePath}
              onMarketClick={onMarketClick}
            />
          ))}
        </div>
      )}

      {/* Footer: aggregate stats */}
      <div className="px-4 py-2 border-t border-rule flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
        {totalDepth > 0 && (
          <span className="flex items-center gap-1">
            <Zap className="w-2.5 h-2.5" />$
            {totalDepth.toFixed(0)} {t("eventChart.total")}
          </span>
        )}
        {earliestDeadlineStr && (
          <span className="flex items-center gap-1">
            <Clock className="w-2.5 h-2.5" />
            {earliestDeadlineStr}
          </span>
        )}
      </div>
    </div>
  );
};
