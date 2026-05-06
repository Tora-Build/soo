/**
 * Liquidity Page — cross-market LP analytics view.
 *
 * Master/detail layout:
 *   Left  : filter + sort + scrollable card grid of every market with
 *           a per-card LP summary (graduation %, depth, deadline, stage).
 *   Right : LiquidityDetailPanel for the selected market — shows the
 *           full GraduationProgress + LPHolders + MarketStats + redeem CTA
 *           that used to live on the AMM page right column.
 *
 * Click any left-panel card → right panel updates.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatUnits } from "@/lib/chain-shim";
import { cn } from "../lib/utils";
import { useVisibleMarkets } from "../hooks";
import { useGraduationRing } from "../hooks/useGraduationRing";
import { StageBadge } from "../components/ui/StageBadge";
import { CategoryBadge } from "../components/ui/CategoryBadge";
import { EntityIcon } from "../components/ui/EntityIcon";
import { LiquidityDetailPanel } from "../components/features/market/LiquidityDetailPanel";
import { useQuickTrade } from "../components/features/market/QuickTradeProvider";
import { CATEGORY_IDS, type CategoryId } from "../lib/categories";

type StageFilter =
  | "all"
  | "bonding"
  | "expired"
  | "live"
  | "settled"
  | "finalized"
  | "dismissed";
type SortKey = "depth" | "recent" | "deadline" | "growth" | "soonest";
function formatDeadline(
  deadline: number | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (!deadline) return null;
  if (deadline > 4102444800) return t("marketsPage.noExpiry"); // year > 2100 sentinel
  const remaining = deadline - Date.now() / 1000;
  if (remaining <= 0) return t("liquidityPage.expired");
  const days = Math.floor(remaining / 86400);
  if (days >= 365)
    return t("liquidityPage.time.yearShort", {
      count: Math.floor(days / 365),
    });
  if (days >= 30)
    return t("liquidityPage.time.monthShort", {
      count: Math.floor(days / 30),
    });
  if (days > 0) return t("liquidityPage.time.dayShort", { count: days });
  const hours = Math.floor(remaining / 3600);
  return t("liquidityPage.time.hourShort", { count: hours });
}

function formatDeadlineSeconds(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
}

function categoryLabel(
  id: CategoryId,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (id === "all") return t("marketsPage.all");
  if (id === "cultures") return t("marketsPage.categories.culture");
  if (id === "others") return t("marketsPage.categories.other");
  return t(`marketsPage.categories.${id}`);
}

interface MarketSummary {
  address: `0x${string}`;
  question: string;
  category?: string;
  event?: string;
  creator: `0x${string}`;
  stage: "bonding" | "expired" | "live" | "settled" | "finalized" | "dismissed";
  bBase: bigint;
  bCurrent: bigint;
  createdAt: bigint;
  deadline?: number;
  trialEndTime?: number;
}

// ─── Card ─────────────────────────────────────────────────────────────────

const LiquidityCard = ({
  market,
  selected,
  onSelect,
}: {
  market: MarketSummary;
  selected: boolean;
  onSelect: () => void;
}) => {
  const { t } = useTranslation();
  const { open: openQuickTrade } = useQuickTrade();
  const { progress } = useGraduationRing({
    marketAddress: market.address,
    stage: market.stage,
  });

  const depth = Number(formatUnits(market.bCurrent, 18));
  const initial = Number(formatUnits(market.bBase, 18));
  const growth = initial > 0 ? ((depth - initial) / initial) * 100 : 0;
  const deadlineStr = formatDeadline(market.deadline, t);

  const nowSec = Math.floor(Date.now() / 1000);
  const trialRemainingSec =
    market.trialEndTime && market.trialEndTime > nowSec
      ? market.trialEndTime - nowSec
      : null;
  const trialStr = trialRemainingSec
    ? formatDeadlineSeconds(trialRemainingSec)
    : null;

  // Graduation progress: bonding markets use the live ring read, graduated
  // markets always show 100%, settled/finalized/dismissed render no bar.
  const showProgressBar = market.stage === "bonding" || market.stage === "live";
  const progressPct =
    market.stage === "live" ? 100 : progress !== undefined ? progress : 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      data-testid={`liquidity-card-${market.address}`}
      className={cn(
        "relative w-full text-left border-l-2 transition-colors",
        "p-4 space-y-3 cursor-pointer",
        selected
          ? "border-accent bg-accent-muted"
          : "border-transparent bg-raised hover:bg-inset",
      )}
    >
      {/* Header row */}
      <div className="flex items-center gap-3">
        <EntityIcon
          question={market.question}
          size="sm"
          market={{ address: market.address, stage: market.stage }}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-ink leading-snug line-clamp-2">
            {market.question}
          </div>
        </div>
        {showProgressBar && (
          <span
            data-testid="liquidity-graduation-pct"
            className={cn(
              "shrink-0 font-mono text-base tabular-nums font-semibold",
              progressPct > 0 ? "text-accent" : "text-ink",
            )}
          >
            {progressPct.toFixed(0)}%
          </span>
        )}
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
        <StageBadge stage={market.stage} />
        {market.category && <CategoryBadge category={market.category} />}
        {trialStr && (
          <span className="flex items-center gap-1 text-accent">
            {trialStr} {t("liquidityPage.trial")}
          </span>
        )}
        {deadlineStr && (
          <span className="flex items-center gap-1">{deadlineStr}</span>
        )}
      </div>

      {/* Stats row + inline Trading CTA (when selected) */}
      <div className="flex items-end gap-3 font-mono text-[10px] uppercase tracking-[0.12em]">
        <div className="grid grid-cols-3 gap-2 flex-1 min-w-0">
          <div>
            <div className="text-faint">{t("liquidityPage.depth")}</div>
            <div className="text-ink tabular-nums normal-case text-xs">
              {formatUsd(depth)}
            </div>
          </div>
          <div>
            <div className="text-faint">{t("liquidityPage.seed")}</div>
            <div className="text-muted tabular-nums normal-case text-xs">
              {formatUsd(initial)}
            </div>
          </div>
          <div>
            <div className="text-faint">{t("liquidityPage.growth")}</div>
            <div
              className={cn(
                "tabular-nums normal-case text-xs",
                growth > 0 ? "text-accent" : "text-muted",
              )}
            >
              {growth >= 0 ? "+" : ""}
              {growth.toFixed(0)}%
            </div>
          </div>
        </div>
        {selected && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openQuickTrade(market.address, "amm");
            }}
            className="shrink-0 inline-flex items-center h-7 px-3 font-mono text-[10px] uppercase tracking-[0.12em] font-bold bg-accent text-canvas hover:opacity-90 transition-opacity"
          >
            Trading
          </button>
        )}
      </div>
    </div>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────

const LiquidityInner = () => {
  const { t } = useTranslation();
  const { markets } = useVisibleMarkets();

  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<StageFilter>("all");
  const [category, setCategory] = useState<CategoryId>("all");
  const [sort, setSort] = useState<SortKey>("depth");
  const [selectedAddress, setSelectedAddress] = useState<`0x${string}` | null>(
    null,
  );
  const stageFilters: { id: StageFilter; label: string }[] = [
    { id: "all", label: t("liquidityPage.filters.all") },
    { id: "bonding", label: t("stage.bonding") },
    { id: "expired", label: t("liquidityPage.filters.expired") },
    { id: "live", label: t("stage.live") },
    { id: "settled", label: t("stage.settled") },
    { id: "finalized", label: t("stage.finalized") },
    { id: "dismissed", label: t("stage.dismissed") },
  ];
  const sortOptions: { id: SortKey; label: string }[] = [
    { id: "depth", label: t("liquidityPage.sort.depth") },
    { id: "growth", label: t("liquidityPage.sort.growth") },
    { id: "recent", label: t("liquidityPage.sort.recent") },
    { id: "deadline", label: t("liquidityPage.sort.deadline") },
    { id: "soonest", label: t("liquidityPage.sort.soonest") },
  ];

  // Cast incoming on-chain data into the MarketSummary shape.
  const rows = useMemo<MarketSummary[]>(() => {
    return markets.map((m) => ({
      address: m.address as `0x${string}`,
      question: m.question || m.name || m.address,
      category: m.category,
      event: m.event,
      creator: m.creator as `0x${string}`,
      stage: m.stage,
      bBase: m.bBase,
      bCurrent: m.bCurrent,
      createdAt: m.createdAt,
      deadline: m.deadline,
      trialEndTime: m.trialEndTime,
    }));
  }, [markets]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((m) => {
      const matchStage = stage === "all" || m.stage === stage;
      const matchCategory = category === "all" || m.category === category;
      const matchSearch =
        q.length === 0 ||
        m.question.toLowerCase().includes(q) ||
        (m.event?.toLowerCase().includes(q) ?? false) ||
        m.address.toLowerCase().includes(q);
      return matchStage && matchCategory && matchSearch;
    });
  }, [rows, stage, category, search]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    if (sort === "depth") {
      copy.sort((a, b) => (a.bCurrent < b.bCurrent ? 1 : -1));
    } else if (sort === "growth") {
      copy.sort((a, b) => {
        const ag =
          a.bBase > 0n
            ? Number(((a.bCurrent - a.bBase) * 10000n) / a.bBase)
            : 0;
        const bg =
          b.bBase > 0n
            ? Number(((b.bCurrent - b.bBase) * 10000n) / b.bBase)
            : 0;
        return bg - ag;
      });
    } else if (sort === "recent") {
      copy.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    } else if (sort === "deadline") {
      copy.sort((a, b) => (a.deadline ?? 0) - (b.deadline ?? 0));
    } else if (sort === "soonest") {
      // Sort by soonest of (trialEndTime, deadline) — whichever comes first
      copy.sort((a, b) => {
        const aMin = Math.min(
          a.trialEndTime ?? Infinity,
          a.deadline ?? Infinity,
        );
        const bMin = Math.min(
          b.trialEndTime ?? Infinity,
          b.deadline ?? Infinity,
        );
        return aMin - bMin;
      });
    }
    return copy;
  }, [filtered, sort]);

  const selectedMarket = useMemo(() => {
    if (selectedAddress) {
      const selected = sorted.find((m) => m.address === selectedAddress);
      if (selected) return selected;
    }
    return sorted[0] ?? null;
  }, [selectedAddress, sorted]);

  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = { all: rows.length };
    for (const m of rows) {
      counts[m.stage] = (counts[m.stage] ?? 0) + 1;
    }
    return counts;
  }, [rows]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: rows.length };
    for (const m of rows) {
      if (!m.category) continue;
      counts[m.category] = (counts[m.category] ?? 0) + 1;
    }
    return counts;
  }, [rows]);

  return (
    <div className="space-y-3">
      {/* Master / Detail */}
      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-3 bg-canvas">
        {/* LEFT: filters + sort + card list */}
        <div className="flex flex-col gap-3 min-w-0">
          {/* Stage filter chips */}
          <div className="bg-raised p-3 flex items-center gap-2 flex-wrap">
            {stageFilters.map((s) => (
              <button
                key={s.id}
                onClick={() => setStage(s.id)}
                className={cn(
                  "px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors",
                  stage === s.id
                    ? "bg-accent text-canvas"
                    : "text-muted hover:text-ink",
                )}
              >
                {s.label}
                {(stageCounts[s.id] ?? 0) > 0 && (
                  <span className="ml-1 opacity-60">
                    ({stageCounts[s.id] ?? 0})
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Category + sort row */}
          <div className="bg-raised p-3 flex flex-col gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              {CATEGORY_IDS.map((id) => (
                <button
                  key={id}
                  onClick={() => setCategory(id)}
                  className={cn(
                    "px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors",
                    category === id
                      ? "text-accent"
                      : "text-muted hover:text-ink",
                  )}
                >
                  {categoryLabel(id, t)}
                  {(categoryCounts[id] ?? 0) > 0 && (
                    <span className="ml-1 opacity-60">
                      ({categoryCounts[id] ?? 0})
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("common.search")}
                className="w-full sm:w-56 bg-transparent border border-accent px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink placeholder:text-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              />

              <div className="sm:ml-auto flex items-center gap-2">
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  className="bg-transparent border border-rule px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink"
                >
                  {sortOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Card list */}
          <div className="flex flex-col gap-2 max-h-[calc(100vh-300px)] overflow-y-auto custom-scrollbar pr-1">
            {sorted.length === 0 && (
              <div className="bg-raised p-8 text-center font-mono text-xs uppercase tracking-[0.12em] text-faint">
                {t("liquidityPage.empty")}
              </div>
            )}
            {sorted.map((m) => (
              <LiquidityCard
                key={m.address}
                market={m}
                selected={m.address === selectedMarket?.address}
                onSelect={() => setSelectedAddress(m.address)}
              />
            ))}
          </div>
        </div>

        {/* RIGHT: detail panel */}
        <div className="lg:sticky lg:top-3 self-start">
          {selectedMarket ? (
            <LiquidityDetailPanel marketAddress={selectedMarket.address} />
          ) : (
            <div className="bg-raised p-8 text-center font-mono text-xs uppercase tracking-[0.12em] text-faint">
              {t("liquidityPage.selectPrompt")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const Liquidity = () => <LiquidityInner />;

export default Liquidity;
