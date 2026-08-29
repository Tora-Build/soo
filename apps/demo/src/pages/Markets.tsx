/**
 * Markets Page — Information-dense market grid (route: /markets)
 *
 * Design: Kalshi/Polymarket-inspired card layout — icon-led, no AI images.
 * Features:
 * - Category-colored accent strip per card
 * - Large price + probability bar as hero
 * - Depth · deadline · event footer
 * - SQF §event piling with stack effect
 * - Sort: Trending / Newest / Ending Soon / Graduated
 * - Search + category tabs + stage filter
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Search,
  TrendingUp,
  Zap,
  BarChart3,
  Trophy,
  Users,
  CloudSun,
  Cpu,
  Layers,
  Clock,
  Flame,
  Database,
} from "lucide-react";
import { formatUnits } from "@/lib/chain-shim";
import { useVisibleMarkets } from "../hooks";
import { useAmmMarketDirect } from "../hooks/useAmmMarketDirect";
import { useGraduationRing } from "../hooks/useGraduationRing";
import { cn } from "../lib/utils";
import {
  CATEGORY_IDS,
  CATEGORY_KEYWORDS,
  inferCategory,
  normalizeCategory,
} from "../lib/categories";
import { StageBadge } from "../components/ui/StageBadge";
import { VetoWindowBadge } from "../components/features/market/VetoWindow";
import { CategoryBadge } from "../components/ui/CategoryBadge";
import { EntityIcon } from "../components/ui/EntityIcon";
import { useQuickTrade } from "../components/features/market/QuickTradeProvider";

// ─── Category visual config ───────────────────────────────────────────────
// Local category map is retained for the filter tab navigation below, which
// needs the Icon component reference for interactive button rendering. The
// canonical data-display rendering goes through `<CategoryBadge>`.
const CATEGORY_CONFIG: Record<
  string,
  { icon: typeof TrendingUp; labelKey: string }
> = {
  sports: { icon: Trophy, labelKey: "marketsPage.categories.sports" },
  tech: { icon: Cpu, labelKey: "marketsPage.categories.tech" },
  cultures: { icon: Users, labelKey: "marketsPage.categories.culture" },
  crypto: { icon: TrendingUp, labelKey: "marketsPage.categories.crypto" },
  politics: { icon: BarChart3, labelKey: "marketsPage.categories.politics" },
  weather: { icon: CloudSun, labelKey: "marketsPage.categories.weather" },
  others: { icon: Zap, labelKey: "marketsPage.categories.other" },
};

// ─── Stage config ─────────────────────────────────────────────────────────
// Local stage labels are for the filter dropdown <option> text only — all
// data-display rendering goes through `<StageBadge>` which owns the
// canonical color/label map.
const STAGE_CONFIG: Record<string, { labelKey: string }> = {
  bonding: { labelKey: "stage.bonding" },
  live: { labelKey: "stage.live" },
  ended: { labelKey: "marketsPage.stage.ended" },
  settled: { labelKey: "marketsPage.stage.resolved" },
  finalized: { labelKey: "stage.settled" },
  dismissed: { labelKey: "stage.dismissed" },
};

const STAGE_IDS = [
  "all",
  "bonding",
  "live",
  "ended",
  "settled",
  "finalized",
  "dismissed",
] as const;

/**
 * The stage a TRADER cares about, which is not the account's lifecycle
 * vocabulary. On-chain "live" means graduated and "bonding" means on the
 * curve — both keep meaning that after the deadline passes, though no trade
 * can land. The filter that says LIVE must mean tradeable, so a past-deadline
 * market maps to "ended" regardless of venue. (The legacy "expired" stage —
 * trial ended without graduation, still tradeable — folds into bonding here;
 * as a filter bucket it answered a question nobody was asking.)
 */
function displayStage(m: { stage: string; deadline?: number }): string {
  if (["settled", "finalized", "dismissed"].includes(m.stage)) return m.stage;
  const ended =
    !!m.deadline &&
    m.deadline > 1_000_000_000 &&
    Date.now() / 1000 >= m.deadline;
  if (ended) return "ended";
  return m.stage === "expired" ? "bonding" : m.stage;
}

// ─── Resolution one-liner from §rule ─────────────────────────────────────
// Produces "binance-price > 200000" or "binance-price" depending on what's set
function formatResolutionLine(
  source?: string,
  op?: string,
  target?: string,
): string | null {
  if (!source) return null;
  if (op && target) {
    const opSymbol =
      op === "gt" || op === ">" ? ">" : op === "lt" || op === "<" ? "<" : op;
    return `${source} ${opSymbol} ${target}`;
  }
  return source;
}
const SORT_OPTIONS = [
  { id: "trending", labelKey: "marketsPage.sort.trending" },
  { id: "newest", labelKey: "marketsPage.sort.newest" },
  { id: "ending", labelKey: "marketsPage.sort.ending" },
  { id: "depth", labelKey: "marketsPage.sort.depth" },
] as const;
type SortId = (typeof SORT_OPTIONS)[number]["id"];

// ─── Card data shape ──────────────────────────────────────────────────────
interface MarketCardData {
  address: string;
  question: string;
  event?: string;
  category: string;
  stage: string;
  isGraduated: boolean;
  bCurrent: bigint;
  createdAt: bigint;
  creator: string;
  deadline?: number;
  ruleDescription?: string;
  ruleSource?: string;
  ruleOp?: string;
  ruleTarget?: string;
}

// ─── Shared price display ─────────────────────────────────────────────────
const PriceBar = ({
  address,
  size = "md",
}: {
  address: string;
  size?: "sm" | "md";
}) => {
  const { amm } = useAmmMarketDirect(address as `0x${string}`);
  const yesPrice = amm?.yesProbability ?? 0.5;
  const noPrice = 1 - yesPrice;

  // The probability IS the market — it deserves to be the card's visual
  // center, not a bare number floating over dead space. Both sides get a
  // labeled, colored reading; the bar is thick enough to read at a glance.
  return (
    <div className="space-y-1.5">
      <div className="flex items-end justify-between font-mono tabular-nums">
        <div className="leading-none">
          <div className="text-[9px] uppercase tracking-[0.14em] text-accent/70 mb-0.5">
            Yes
          </div>
          <span
            className={cn(
              "font-bold text-accent",
              size === "sm" ? "text-base" : "text-2xl",
            )}
          >
            {(yesPrice * 100).toFixed(0)}
            <span className="text-sm font-medium">%</span>
          </span>
        </div>
        <div className="leading-none text-right">
          <div className="text-[9px] uppercase tracking-[0.14em] text-error/70 mb-0.5">
            No
          </div>
          <span
            className={cn(
              "font-bold text-error/90",
              size === "sm" ? "text-sm" : "text-lg",
            )}
          >
            {(noPrice * 100).toFixed(0)}
            <span className="text-xs font-medium">%</span>
          </span>
        </div>
      </div>
      <div
        className={cn(
          "bg-inset overflow-hidden flex rounded-sm",
          size === "sm" ? "h-1" : "h-1.5",
        )}
      >
        <div
          className="h-full bg-accent transition-all duration-700"
          style={{ width: `${yesPrice * 100}%` }}
        />
        <div
          className="h-full bg-error/60 transition-all duration-700"
          style={{ width: `${noPrice * 100}%` }}
        />
      </div>
    </div>
  );
};

// ─── Entity icon (per-market / per-event) ────────────────────────────────
// Three layers:
//   1. Outer frame — conic-gradient progress ring showing the bonding-
//      curve graduation percentage for bonding markets. Graduated markets
//      render as a full gold ring; non-market contexts (event header)
//      fall back to a plain hairline border.
//   2. Inner tile — circular, either the resolved entity image (CoinGecko
//      / Wikipedia / FlagCDN / Google favicon) OR the initial-letter
//      fallback tinted with the LLM's category accent.

// ─── Deadline formatting ──────────────────────────────────────────────────
/**
 * "ENDED" beside the stage badge once the deadline passes.
 *
 * StageBadge's own "expired" means something else entirely (trial ended,
 * trading still allowed), and its "live" keeps its green pulse right through
 * the deadline — so deadline-expiry needs its own chip, not a reused stage.
 */
function EndedChip({ deadline }: { deadline?: number }) {
  if (!deadline || deadline > 4102444800) return null;
  if (Date.now() / 1000 < deadline) return null;
  return (
    <span className="font-mono text-[10px] uppercase tracking-[0.12em] px-1.5 py-0.5 border border-amber-500/50 text-amber-400">
      ENDED
    </span>
  );
}

function formatDeadline(
  deadline: number | undefined,
  locale: string,
  noExpiryLabel: string,
): string | null {
  if (!deadline || deadline <= 0) return null;
  if (deadline > 4102444800) return noExpiryLabel;
  return new Date(deadline * 1000).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Individual market card ───────────────────────────────────────────────
const MarketCard = ({ market }: { market: MarketCardData }) => {
  const { t, i18n } = useTranslation();
  const liquidity = Number(formatUnits(market.bCurrent, 18));
  const deadlineStr = formatDeadline(
    market.deadline,
    i18n.language === "zh" ? "zh-CN" : "en-US",
    t("marketsPage.noExpiry"),
  );
  const { open: openQuickTrade } = useQuickTrade();
  // Graduation progress number — cached by React Query so this is free
  // when EntityIcon below also reads it via the same hook+key.
  const { progress: gradProgress } = useGraduationRing({
    marketAddress: market.address as `0x${string}`,
    stage: market.stage,
  });

  // A market can take an order only while open AND inside its deadline —
  // mirrors the program's TradingClosed gate (1e9 floor excludes epoch-
  // relative test clocks).
  const isTradeable =
    !["settled", "finalized", "dismissed"].includes(market.stage) &&
    !(
      market.deadline &&
      market.deadline > 1_000_000_000 &&
      Date.now() / 1000 >= market.deadline
    );

  // Card click opens the wide MarketDrawer (full AMM/Orderbook surface)
  // instead of navigating to /amm/:addr. The /amm/:addr and /orderbook/:addr
  // routes still work as deep links from elsewhere — Portfolio rows, direct
  // URLs, QuickTradeProvider's no-op deep links, etc.
  const openMarket = () =>
    openQuickTrade(
      market.address,
      market.stage === "live" ? "orderbook" : "amm",
    );
  return (
    <div
      className="group flex flex-col bg-raised border border-rule hover:border-accent/50 focus-within:border-accent/50 transition-all cursor-pointer"
      role="link"
      tabIndex={0}
      onClick={openMarket}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openMarket();
        }
      }}
      data-testid="market-card"
      data-market={market.address}
    >
      <div className="flex flex-col p-3 gap-2.5">
        {/* Identity row: icon + question, chance on the right — the
            Polymarket grammar: the question and its probability are the
            card; everything else is a footnote. */}
        <div className="flex items-start gap-2.5">
          <div className="pt-0.5 shrink-0">
            <EntityIcon
              question={market.question}
              market={{
                address: market.address as `0x${string}`,
                stage: market.stage,
              }}
            />
          </div>
          <h3
            className={cn(
              "flex-1 min-w-0 text-sm leading-snug line-clamp-2 group-hover:text-accent transition-colors",
              market.question && market.question.trim().length > 0
                ? "font-medium text-ink"
                : "font-mono text-muted",
            )}
          >
            {market.question?.trim() ||
              `${market.address.slice(0, 8)}…${market.address.slice(-6)}`}
          </h3>
          <ChanceGauge address={market.address} />
        </div>

        {/* Actions: the two sides, as buttons — but ONLY on a market that
            can take an order. The program rejects every trade past the
            deadline or after settlement, and a Buy button on a dead market
            is the affordance lying. Closed markets state their status in
            the same slot instead, so cards keep one rhythm. */}
        {isTradeable ? (
          <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={openMarket}
              className="flex-1 py-1.5 font-mono text-xs font-bold uppercase tracking-[0.08em] bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/25 transition-colors rounded-sm"
              data-testid="card-buy-yes"
            >
              {t("marketsPage.buyYes", { defaultValue: "Buy Yes" })}
            </button>
            <button
              type="button"
              onClick={openMarket}
              className="flex-1 py-1.5 font-mono text-xs font-bold uppercase tracking-[0.08em] bg-error/10 text-error hover:bg-error/25 transition-colors rounded-sm"
              data-testid="card-buy-no"
            >
              {t("marketsPage.buyNo", { defaultValue: "Buy No" })}
            </button>
          </div>
        ) : (
          <div
            className="py-1.5 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-faint bg-inset rounded-sm"
            data-testid="card-closed"
          >
            {market.stage === "settled" || market.stage === "finalized"
              ? t("marketsPage.cardSettled", { defaultValue: "Settled — view results" })
              : t("marketsPage.cardClosed", { defaultValue: "Trading closed — resolution pending" })}
          </div>
        )}

        {/* Footnote row: volume, clock, category — and only NOTEWORTHY
            states get a badge. "Live" is the default condition of a market,
            and a badge that is always present labels nothing. */}
        <div className="flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.1em] text-faint min-w-0">
          <span className="flex items-center gap-1 shrink-0">
            <Zap className="w-2.5 h-2.5" />${liquidity.toFixed(0)}
          </span>
          {deadlineStr && (
            <span className="flex items-center gap-1 shrink-0">
              <Clock className="w-2.5 h-2.5" />
              {deadlineStr}
            </span>
          )}
          {market.stage === "bonding" && gradProgress !== undefined && (
            <span className="text-accent tabular-nums shrink-0">
              {Math.round(gradProgress)}%
            </span>
          )}
          <span className="flex-1" />
          <EndedChip deadline={market.deadline} />
          <VetoWindowBadge address={market.address} />
          {["settled", "finalized", "dismissed", "expired"].includes(
            market.stage,
          ) && <StageBadge stage={market.stage} />}
          <CategoryBadge category={market.category} />
        </div>
      </div>
    </div>
  );
};

/**
 * The Polymarket-style "chance" block: one number, a hemisphere gauge, the
 * word underneath. One number, because a binary market has one price and
 * showing both sides twice (numbers AND bar AND buttons) was the clutter.
 */
const ChanceGauge = ({ address }: { address: string }) => {
  const { amm } = useAmmMarketDirect(address as `0x${string}`);
  const yes = amm?.yesProbability ?? 0.5;
  const pct = Math.round(yes * 100);
  // Semicircle arc: radius 16, circumference of the half = PI * r.
  const r = 15;
  const half = Math.PI * r;
  return (
    <div className="shrink-0 flex flex-col items-center leading-none pt-0.5">
      <svg width="40" height="24" viewBox="0 0 40 24" aria-hidden>
        <path
          d="M 4 22 A 16 16 0 0 1 36 22"
          fill="none"
          strokeWidth="3.5"
          strokeLinecap="round"
          className="text-muted/20"
          stroke="currentColor"
        />
        <path
          d="M 4 22 A 16 16 0 0 1 36 22"
          fill="none"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${half * yes} ${half}`}
          className={yes >= 0.5 ? "stroke-emerald-500" : "stroke-error"}
        />
      </svg>
      <span
        className={cn(
          "font-mono font-bold tabular-nums text-base -mt-2.5",
          yes >= 0.5 ? "text-emerald-500" : "text-error",
        )}
      >
        {pct}%
      </span>
      <span className="font-mono text-[8px] uppercase tracking-[0.14em] text-faint mt-0.5">
        chance
      </span>
    </div>
  );
};


// ─── Event outcome row (one sibling market inside an event card) ──────────
const EventOutcomeRow = ({ market }: { market: MarketCardData }) => {
  const { t, i18n } = useTranslation();
  const deadlineStr = formatDeadline(
    market.deadline,
    i18n.language === "zh" ? "zh-CN" : "en-US",
    t("marketsPage.noExpiry"),
  );
  const liquidity = Number(formatUnits(market.bCurrent, 18));
  const { open: openQuickTrade } = useQuickTrade();
  const { progress: gradProgress } = useGraduationRing({
    marketAddress: market.address as `0x${string}`,
    stage: market.stage,
  });

  const openMarket = () =>
    openQuickTrade(
      market.address,
      market.stage === "live" ? "orderbook" : "amm",
    );
  return (
    <div
      className="group/row px-4 py-3 hover:bg-inset focus-within:bg-inset transition-colors cursor-pointer"
      role="link"
      tabIndex={0}
      onClick={openMarket}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openMarket();
        }
      }}
    >
      <div className="flex items-center gap-3">
        {/* Left: entity icon + question + meta */}
        <EntityIcon
          question={market.question}
          size="sm"
          market={{
            address: market.address as `0x${string}`,
            stage: market.stage,
          }}
        />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="text-xs text-ink leading-snug line-clamp-1 group-hover/row:text-accent transition-colors">
            {market.question}
          </div>
          <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
            <span className="flex items-center gap-1.5">
              <StageBadge stage={market.stage} />
              <EndedChip deadline={market.deadline} />
              {market.stage === "bonding" && gradProgress !== undefined && (
                <span className="text-accent tabular-nums">
                  {Math.round(gradProgress)}%
                </span>
              )}
            </span>
            <VetoWindowBadge address={market.address} />
            <span className="flex items-center gap-1">
              <Zap className="w-2.5 h-2.5" />${liquidity.toFixed(0)}
            </span>
            {deadlineStr && (
              <span className="flex items-center gap-1">
                <Clock className="w-2.5 h-2.5" />
                {deadlineStr}
              </span>
            )}
          </div>
        </div>

        {/* Right: price bar */}
        <div className="w-20 shrink-0">
          <PriceBar address={market.address} size="sm" />
        </div>
      </div>
    </div>
  );
};

// ─── Event card (spans 2 columns, multi-outcome Polymarket-style) ─────────
const EventGroupCard = ({
  event,
  markets,
}: {
  event: string;
  markets: MarketCardData[];
}) => {
  const { t } = useTranslation();
  // Show top 5 markets — expand to see all
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? markets : markets.slice(0, 5);
  const hiddenCount = markets.length - visible.length;

  return (
    <div className="sm:col-span-2 bg-raised border border-rule border-l-2 border-l-accent/40 hover:border-accent/50 transition-all">
      {/* Event header */}
      <div className="px-4 py-3 border-b border-rule flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <EntityIcon question={event} />
          <Layers className="w-4 h-4 text-accent shrink-0" />
          <span className="font-mono text-xs uppercase tracking-[0.12em] text-accent font-bold truncate">
            {event}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint shrink-0">
            {t("marketsPage.outcomesCount", { count: markets.length })}
          </span>
        </div>
        <div className="shrink-0">
          <CategoryBadge category={markets[0].category} />
        </div>
      </div>

      {/* Sibling market rows */}
      <div className="divide-y divide-rule/40">
        {visible.map((m) => (
          <EventOutcomeRow key={m.address} market={m} />
        ))}
      </div>

      {/* Show more */}
      {hiddenCount > 0 && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full px-4 py-2 border-t border-rule font-mono text-[10px] uppercase tracking-[0.12em] text-muted hover:text-accent hover:bg-inset transition-colors"
        >
          {t(
            hiddenCount === 1
              ? "marketsPage.moreOutcome"
              : "marketsPage.moreOutcomes",
            { count: hiddenCount },
          )}
        </button>
      )}
    </div>
  );
};

// ─── Main Page ────────────────────────────────────────────────────────────
const ALL_CATEGORIES = CATEGORY_IDS;

const MarketsInner = () => {
  const { t } = useTranslation();
  const { markets: onChainMarkets, isLoading } = useVisibleMarkets();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [stage, setStage] = useState<string>("all");
  const [sort, setSort] = useState<SortId>("trending");

  // Enrich markets
  const markets = useMemo<MarketCardData[]>(() => {
    return onChainMarkets.map((m) => {
      let localMeta: { category?: string } | null = null;
      try {
        const stored = localStorage.getItem(
          `market_meta_${m.address.toLowerCase()}`,
        );
        if (stored) localMeta = JSON.parse(stored);
      } catch {
        /* ignore */
      }

      return {
        address: m.address,
        question: m.question,
        event: m.event,
        category: normalizeCategory(
          m.category?.toLowerCase() ||
            localMeta?.category ||
            inferCategory(m.question),
        ),
        stage: m.stage,
        isGraduated: m.isGraduated,
        bCurrent: m.bCurrent,
        createdAt: m.createdAt,
        creator: m.creator,
        deadline: m.deadline,
        ruleDescription: m.ruleDescription,
        ruleSource: m.rule?.source,
        ruleOp: m.rule?.op,
        ruleTarget: m.rule?.target,
      };
    });
  }, [onChainMarkets]);

  // Filter
  const filtered = useMemo(() => {
    return markets.filter((m) => {
      const q = search.toLowerCase();
      const matchSearch =
        !search ||
        m.question.toLowerCase().includes(q) ||
        // Addresses too: pasting a PDA or creator key into search must find
        // the market — an explorer that can't look up by address isn't one.
        m.address.toLowerCase().includes(q) ||
        m.creator.toLowerCase().includes(q) ||
        m.event?.toLowerCase().includes(q) ||
        m.ruleDescription?.toLowerCase().includes(q) ||
        m.ruleSource?.toLowerCase().includes(q) ||
        (m.category &&
          CATEGORY_KEYWORDS[m.category]?.some(
            (kw) => kw.includes(q) || q.includes(kw),
          ));
      const matchCat = category === "all" || m.category === category;
      const matchStage = stage === "all" || displayStage(m) === stage;
      return matchSearch && matchCat && matchStage;
    });
  }, [markets, search, category, stage]);

  // Sort
  const sorted = useMemo(() => {
    const copy = [...filtered];
    switch (sort) {
      case "newest":
        // createdAt is never populated by the listing (always 0), which made
        // this sort a silent no-op. Deadline descending is the working proxy:
        // markets are created with fixed-length windows, so later deadlines
        // are newer markets.
        return copy.sort((a, b) => (b.deadline ?? 0) - (a.deadline ?? 0));
      case "ending":
        return copy.sort((a, b) => {
          const aDead = a.deadline ?? Infinity;
          const bDead = b.deadline ?? Infinity;
          return aDead - bDead;
        });
      case "depth":
        return copy.sort((a, b) => Number(b.bCurrent - a.bCurrent));
      case "trending":
      default:
        // Trending = graduated first, then by depth
        return copy.sort((a, b) => {
          if (a.isGraduated !== b.isGraduated) return a.isGraduated ? -1 : 1;
          return Number(b.bCurrent - a.bCurrent);
        });
    }
  }, [filtered, sort]);

  // Group by event
  const [visibleCount, setVisibleCount] = useState(24);
  // New filters mean a new list; showing page 3 of the old one is a lie.
  useEffect(() => {
    setVisibleCount(24);
  }, [search, category, stage, sort]);

  const groupedDisplay = useMemo(() => {
    const eventMap = new Map<string, MarketCardData[]>();
    const ungrouped: MarketCardData[] = [];

    for (const m of sorted) {
      if (m.event) {
        const groupKey = `${m.creator.toLowerCase()}::${m.event.toLowerCase()}`;
        if (!eventMap.has(groupKey)) eventMap.set(groupKey, []);
        eventMap.get(groupKey)!.push(m);
      } else {
        ungrouped.push(m);
      }
    }

    const result: { key: string; event?: string; markets: MarketCardData[] }[] =
      [];

    for (const [groupKey, eventMarkets] of eventMap) {
      if (eventMarkets.length >= 2) {
        result.push({
          key: groupKey,
          event: eventMarkets[0].event,
          markets: eventMarkets,
        });
      } else {
        ungrouped.push(...eventMarkets);
      }
    }

    for (const m of ungrouped) {
      result.push({ key: m.address, markets: [m] });
    }

    return result;
  }, [sorted]);

  // Category counts
  const categoryCounts = useMemo(() => {
    const stageFiltered =
      stage === "all"
        ? markets
        : markets.filter((m) => displayStage(m) === stage);
    const counts: Record<string, number> = { all: stageFiltered.length };
    for (const m of stageFiltered) {
      counts[m.category] = (counts[m.category] || 0) + 1;
    }
    return counts;
  }, [markets, stage]);

  // Stage counts
  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = { all: filtered.length };
    for (const m of filtered) {
      counts[m.stage] = (counts[m.stage] || 0) + 1;
    }
    return counts;
  }, [filtered]);

  return (
    <div className="space-y-5">
      {/* Header: title + right-aligned search */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-xl font-bold text-ink flex items-center gap-2">
          <Flame className="w-5 h-5 text-accent" />
          {t("nav.markets")}
        </h1>
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type="text"
            placeholder={t("common.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-field pl-10 pr-4 py-2 text-sm w-full"
          />
        </div>
      </div>

      {/* Category tabs + Stage dropdown on same row */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-rule">
        <div className="flex flex-wrap gap-5">
          {ALL_CATEGORIES.map((cat) => {
            const count = categoryCounts[cat] ?? 0;
            const active = category === cat;
            const config = CATEGORY_CONFIG[cat];
            const Icon = config?.icon;
            return (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={cn(
                  "font-mono text-xs uppercase tracking-[0.12em] pb-3 transition-all flex items-center gap-1.5 border-b-2",
                  active
                    ? "text-accent border-accent"
                    : "text-faint hover:text-muted border-transparent",
                )}
              >
                {Icon && <Icon className="w-3 h-3" />}
                {cat === "all"
                  ? t("marketsPage.all")
                  : config
                    ? t(config.labelKey)
                    : cat}
                {count > 0 && (
                  <span
                    className={cn(
                      "text-[10px]",
                      active ? "text-accent" : "text-faint",
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Stage + Sort dropdowns */}
        <div className="flex items-center gap-4 shrink-0 pb-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
              {t("marketsPage.stageLabel")}
            </span>
            <select
              value={stage}
              onChange={(e) => setStage(e.target.value)}
              className="bg-raised border border-rule px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink hover:border-accent/40 focus:border-accent focus:outline-none cursor-pointer"
            >
              {STAGE_IDS.map((s) => {
                const count = stageCounts[s] ?? 0;
                const label =
                  s === "all"
                    ? t("marketsPage.all")
                    : t(STAGE_CONFIG[s]?.labelKey ?? s);
                return (
                  <option key={s} value={s}>
                    {label}
                    {count > 0 ? ` (${count})` : ""}
                  </option>
                );
              })}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
              {t("marketsPage.sortLabel")}
            </span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortId)}
              className="bg-raised border border-rule px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink hover:border-accent/40 focus:border-accent focus:outline-none cursor-pointer"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {t(opt.labelKey)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent animate-spin" />
          <span className="ml-3 text-muted font-mono text-sm">
            {t("amm.discoveringMarkets")}
          </span>
        </div>
      )}

      {/* Empty */}
      {!isLoading && sorted.length === 0 && (
        <div className="text-center py-16">
          <p className="text-ink font-bold mb-2">{t("amm.noMarketsFound")}</p>
          <p className="text-muted text-sm max-w-md mx-auto">
            {search
              ? t("marketsPage.noMatch", { search })
              : t("marketsPage.noMarketsOnChain")}
          </p>
        </div>
      )}

      {/* Card grid */}
      {!isLoading && sorted.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {groupedDisplay.slice(0, visibleCount).map((group) =>
            group.event ? (
              <EventGroupCard
                key={group.key}
                event={group.event}
                markets={group.markets}
              />
            ) : (
              <MarketCard key={group.key} market={group.markets[0]} />
            ),
          )}
        </div>
      )}
      {groupedDisplay.length > visibleCount && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => setVisibleCount((n) => n + 24)}
            className="px-6 py-2 font-mono text-xs uppercase tracking-[0.12em] border border-rule text-muted hover:text-ink hover:border-accent transition-all"
            data-testid="markets-load-more"
          >
            {t("marketsPage.loadMore", {
              defaultValue: "Show more ({{shown}} of {{total}})",
              shown: visibleCount,
              total: groupedDisplay.length,
            })}
          </button>
        </div>
      )}
    </div>
  );
};

export const Markets = () => <MarketsInner />;

export default Markets;
