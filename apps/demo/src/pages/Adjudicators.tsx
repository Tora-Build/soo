/**
 * The adjudicator leaderboard — every scored authority on this chain, ranked.
 *
 * This is the reputation system's public face. The SCORE is the biggest
 * thing on every row, because it is the number decisions get made on; the
 * evidence sits under it, the methodology at the bottom, and the full
 * address is always one click from the clipboard — an identity you cannot
 * copy is an identity you cannot use.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Scale, ArrowRight, Copy, Search } from "lucide-react";
import toast from "react-hot-toast";
import {
  traitsOf,
  RULING_POINTS,
  BOND_POINTS,
  type TrustTier,
} from "@sooth/sdk-solana";

import { useAdjudicatorScores } from "../features/arena/useAdjudicatorScores";
import { AdjudicatorTierChip } from "../components/features/AdjudicatorRecordCard";
import { useAccount } from "@/lib/chain-shim";
import { cn } from "../lib/utils";

function fmtResponse(sec: number | null): string {
  if (sec === null) return "—";
  if (sec === 0) return "instant";
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

const TIER_FILTERS: Array<{ id: TrustTier | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "trusted", label: "Trusted" },
  { id: "standing", label: "In standing" },
  { id: "caution", label: "Caution" },
  { id: "unproven", label: "Unproven" },
];

const TRAIT_FILTERS = [
  { id: "fast", label: "Fast" },
  { id: "spotless", label: "Spotless" },
  { id: "veteran", label: "Veteran" },
  { id: "bonded", label: "Bonded" },
  { id: "guardian", label: "Guardian" },
] as const;

export function CopyableAddress({ address }: { address: string }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        navigator.clipboard.writeText(address);
        toast.success("Address copied");
      }}
      title={address}
      className="inline-flex items-center gap-1.5 font-mono text-xs text-muted hover:text-ink transition-colors"
    >
      <span>
        {address.slice(0, 8)}…{address.slice(-8)}
      </span>
      <Copy className="h-3 w-3 shrink-0" />
    </button>
  );
}

export default function Adjudicators() {
  const { t } = useTranslation();
  const { address } = useAccount();
  const self = address ? String(address).replace(/^0x/, "") : null;
  const { byAuthority, hasLoaded } = useAdjudicatorScores();
  const [tierFilter, setTierFilter] = useState<TrustTier | "all">("all");
  const [traitFilter, setTraitFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(20);
  useEffect(() => {
    setVisibleCount(20);
  }, [tierFilter, traitFilter, search]);

  const ranked = useMemo(
    () =>
      [...byAuthority.entries()]
        .filter(([, score]) => tierFilter === "all" || score.tier === tierFilter)
        .filter(
          ([, score]) =>
            !traitFilter ||
            traitsOf(score.record).some((trait) => trait.id === traitFilter),
        )
        // Free-text: address substring, or a tier/trait word ("trusted",
        // "fast") typed instead of clicked. Adjudicators have no display
        // names on-chain — the address IS the name, so it must be findable.
        .filter(([authority, score]) => {
          const q = search.trim().toLowerCase();
          if (!q) return true;
          if (authority.toLowerCase().includes(q)) return true;
          if (score.tier.includes(q)) return true;
          return traitsOf(score.record).some((trait) =>
            trait.label.toLowerCase().includes(q),
          );
        })
        .sort(
          (a, b) =>
            b[1].score - a[1].score ||
            b[1].record.resolvedRulings - a[1].record.resolvedRulings,
        ),
    [byAuthority, tierFilter, traitFilter, search],
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-5">
      <header className="space-y-2">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">
          <Scale className="h-5 w-5 text-accent" />
          {t("adjudicators.title", { defaultValue: "Adjudicators" })}
        </h1>
        <p className="text-sm text-muted leading-relaxed max-w-prose">
          {t("adjudicators.subtitle", {
            defaultValue:
              "Every authority that has ruled, vetoed, proposed or challenged on this chain, scored from public history. Pick one when creating a market — or build your own record by ruling well.",
          })}
        </p>
        <Link
          to="/forge"
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-accent hover:underline"
        >
          {t("adjudicators.forgeCta", {
            defaultValue: "Create a market with one of them",
          })}
          <ArrowRight className="w-3 h-3" />
        </Link>
      </header>

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-faint" />
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("adjudicators.searchPlaceholder", {
            defaultValue: "Search by address, tier or trait…",
          })}
          data-testid="adjudicators-search"
          className="w-full bg-inset border border-rule pl-8 pr-3 py-2 font-mono text-xs text-ink placeholder:text-faint focus:outline-none focus:border-accent"
        />
      </div>

      {/* Filters: tier is the primary axis, traits the secondary. */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-1.5" data-testid="tier-filters">
          {TIER_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setTierFilter(f.id)}
              aria-pressed={tierFilter === f.id}
              className={cn(
                "px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] border transition-all",
                tierFilter === f.id
                  ? "border-accent bg-accent-muted text-accent"
                  : "border-rule text-muted hover:text-ink",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" data-testid="trait-filters">
          {TRAIT_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() =>
                setTraitFilter(traitFilter === f.id ? null : f.id)
              }
              aria-pressed={traitFilter === f.id}
              className={cn(
                "px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] border transition-all",
                traitFilter === f.id
                  ? "border-accent bg-accent-muted text-accent"
                  : "border-rule text-faint hover:text-ink",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {!hasLoaded ? (
        <p className="font-mono text-xs text-muted">
          {t("common.loading", { defaultValue: "Loading…" })}
        </p>
      ) : ranked.length === 0 ? (
        <p className="font-mono text-xs text-muted">
          {t("adjudicators.emptyFiltered", {
            defaultValue: "Nobody matches these filters.",
          })}
        </p>
      ) : (
        <ol className="space-y-2" data-testid="adjudicator-leaderboard">
          {ranked.slice(0, visibleCount).map(([authority, score], index) => (
            <li
              key={authority}
              className="border border-rule bg-inset px-4 py-3 flex items-center gap-4"
            >
              {/* THE number. Everything else on the row explains it. */}
              <div className="shrink-0 w-16 text-center">
                <div
                  className={cn(
                    "text-3xl font-bold tabular-nums leading-none",
                    score.tier === "trusted"
                      ? "text-pos"
                      : score.tier === "caution"
                        ? "text-neg"
                        : score.tier === "standing"
                          ? "text-info"
                          : "text-muted",
                  )}
                >
                  {score.score}
                </div>
                <div className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
                  #{index + 1}
                </div>
              </div>

              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <AdjudicatorTierChip score={score} />
                  {authority === self && (
                    <span className="font-mono text-[9px] uppercase tracking-[0.1em] px-1 py-0.5 border border-accent/60 text-accent">
                      {t("adjudicators.you", { defaultValue: "YOU" })}
                    </span>
                  )}
                  {traitsOf(score.record).map((trait) => (
                    <span
                      key={trait.id}
                      title={trait.detail}
                      className="font-mono text-[9px] uppercase tracking-[0.1em] px-1 py-0.5 border border-rule text-muted"
                    >
                      {trait.label}
                    </span>
                  ))}
                </div>
                <CopyableAddress address={authority} />
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px] text-muted">
                  <span>{score.record.resolvedRulings} resolved</span>
                  <span className="text-pos">
                    {score.record.cleanRulings} clean
                  </span>
                  {score.record.overriddenRulings > 0 && (
                    <span className="text-neg">
                      {score.record.overriddenRulings} vetoed
                    </span>
                  )}
                  {score.record.forcedInvalids > 0 && (
                    <span className="text-warn">
                      {score.record.forcedInvalids} forced invalid
                    </span>
                  )}
                  <span>
                    rules in {fmtResponse(score.record.medianResponseSec)}
                  </span>
                  {score.record.vetoesIssued > 0 && (
                    <span>{score.record.vetoesIssued} vetoes issued</span>
                  )}
                  {score.record.proposalsUpheld + score.record.proposalsSlashed >
                    0 && (
                    <span>
                      bonds: {score.record.proposalsUpheld} upheld
                      {score.record.proposalsSlashed > 0 &&
                        ` · ${score.record.proposalsSlashed} slashed`}
                    </span>
                  )}
                  {score.record.challengesWon + score.record.challengesLost >
                    0 && (
                    <span>
                      challenges: {score.record.challengesWon}W /{" "}
                      {score.record.challengesLost}L
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {ranked.length > visibleCount && (
        <div className="text-center">
          <button
            type="button"
            onClick={() => setVisibleCount((n) => n + 20)}
            className="px-6 py-2 font-mono text-xs uppercase tracking-[0.12em] border border-rule text-muted hover:text-ink hover:border-accent transition-all"
            data-testid="adjudicators-load-more"
          >
            {t("adjudicators.loadMore", {
              defaultValue: "Show more ({{shown}} of {{total}})",
              shown: visibleCount,
              total: ranked.length,
            })}
          </button>
        </div>
      )}

      <footer className="border-t border-rule pt-4 space-y-1.5">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
          {t("adjudicators.methodology", { defaultValue: "How scoring works" })}
        </h2>
        <p className="font-mono text-[11px] text-muted leading-relaxed">
          Rulings: clean {`+${RULING_POINTS.clean}`} (prompt{" "}
          {`+${RULING_POINTS.promptBonus}`}) · vetoed {RULING_POINTS.overridden} ·
          forced invalid {RULING_POINTS.forcedInvalid} · unresponsive{" "}
          {RULING_POINTS.unresponsive}. Bonds: upheld{" "}
          {`+${BOND_POINTS.proposalUpheld}`} · slashed{" "}
          {BOND_POINTS.proposalSlashed} · challenge won{" "}
          {`+${BOND_POINTS.challengeWon}`} · lost {BOND_POINTS.challengeLost}.
          Score starts at 50; tiers need at least 3 resolved rulings. Every
          number is recomputable from public chain state.
        </p>
      </footer>
    </div>
  );
}
