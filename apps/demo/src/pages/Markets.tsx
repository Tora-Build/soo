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
import { useMemo, useState } from "react";
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
  expired: { labelKey: "marketsPage.stage.expired" },
  live: { labelKey: "stage.live" },
  settled: { labelKey: "marketsPage.stage.resolved" },
  finalized: { labelKey: "stage.settled" },
  dismissed: { labelKey: "stage.dismissed" },
};

const STAGE_IDS = [
  "all",
  "bonding",
  "expired",
  "live",
  "settled",
  "finalized",
  "dismissed",
] as const;

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

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between font-mono tabular-nums">
        <span
          className={cn(
            "font-bold text-accent",
            size === "sm" ? "text-base" : "text-2xl",
          )}
        >
          {(yesPrice * 100).toFixed(0)}%
        </span>
        <span
          className={cn("text-muted", size === "sm" ? "text-xs" : "text-sm")}
        >
          {(noPrice * 100).toFixed(0)}%
        </span>
      </div>
      <div className="h-1 bg-inset overflow-hidden flex">
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
  const resolutionLine = formatResolutionLine(
    market.ruleSource,
    market.ruleOp,
    market.ruleTarget,
  );
  const { open: openQuickTrade } = useQuickTrade();
  // Graduation progress number — cached by React Query so this is free
  // when EntityIcon below also reads it via the same hook+key.
  const { progress: gradProgress } = useGraduationRing({
    marketAddress: market.address as `0x${string}`,
    stage: market.stage,
  });

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
      className="group flex flex-col bg-raised border border-rule hover:border-accent/50 focus-within:border-accent/50 transition-all cursor-pointer aspect-[4/3]"
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
      <div className="flex-1 flex flex-col p-3 gap-2">
        {/* Top row: stage (+ graduation %) + category */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <StageBadge stage={market.stage} />
            {market.stage === "bonding" && gradProgress !== undefined && (
              <span className="font-mono text-[10px] text-accent tabular-nums">
                {Math.round(gradProgress)}%
              </span>
            )}
          </div>
          <CategoryBadge category={market.category} />
        </div>

        {/* Question — hero (with entity icon + graduation ring) */}
        <div className="flex items-start gap-2">
          <div className="pt-0.5">
            <EntityIcon
              question={market.question}
              market={{
                address: market.address as `0x${string}`,
                stage: market.stage,
              }}
            />
          </div>
          <h3 className="text-sm font-medium text-ink leading-snug line-clamp-2 group-hover:text-accent transition-colors">
            {market.question}
          </h3>
        </div>

        {/* Liquidity + deadline (right under question) */}
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
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

        {/* Resolution source one-liner (from §rule) */}
        {resolutionLine && (
          <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted truncate">
            <Database className="w-2.5 h-2.5 shrink-0" />
            <span className="truncate">{resolutionLine}</span>
          </div>
        )}

        {/* Bottom block: price bar (pinned to card bottom) */}
        <div className="mt-auto pt-2">
          <PriceBar address={market.address} />
        </div>
      </div>
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
              {market.stage === "bonding" && gradProgress !== undefined && (
                <span className="text-accent tabular-nums">
                  {Math.round(gradProgress)}%
                </span>
              )}
            </span>
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
        m.event?.toLowerCase().includes(q) ||
        m.ruleDescription?.toLowerCase().includes(q) ||
        m.ruleSource?.toLowerCase().includes(q) ||
        (m.category &&
          CATEGORY_KEYWORDS[m.category]?.some(
            (kw) => kw.includes(q) || q.includes(kw),
          ));
      const matchCat = category === "all" || m.category === category;
      const matchStage = stage === "all" || m.stage === stage;
      return matchSearch && matchCat && matchStage;
    });
  }, [markets, search, category, stage]);

  // Sort
  const sorted = useMemo(() => {
    const copy = [...filtered];
    switch (sort) {
      case "newest":
        return copy.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
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
      stage === "all" ? markets : markets.filter((m) => m.stage === stage);
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
          {groupedDisplay.map((group) =>
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
    </div>
  );
};

export const Markets = () => <MarketsInner />;

export default Markets;
