/**
 * MarketDetailsCard — flat 4-line layout for AMM/Orderbook surfaces.
 *
 * Line 1: stage · fee · deadline · $market · creator · adjudicator (chips)
 * Line 2: market question
 * Line 3: the SQF rule's fields, inline
 */
import { useAdjudicatorScore } from "../../../features/arena/useAdjudicatorScores";
import { AdjudicatorTierChip } from "../AdjudicatorRecordCard";
import { Shield, Calendar, User, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "react-hot-toast";
import type { SQFRule } from "../../../lib/sqf";
import { getAddressExplorerUrl } from "../../../lib/chains";
import { StageBadge } from "../../ui/StageBadge";

interface MarketDetailsCardProps {
  address: string;
  symbol?: string;
  creator?: string;
  adjudicator?: string;
  deadline?: number;
  stage: "bonding" | "live" | "settled" | "finalized" | "dismissed" | string;
  isGraduated?: boolean;
  /** Taker fee for this market's ACTIVE venue, in bps, read from the chain. */
  currentFeeBps?: bigint | number;
  isInTrialPeriod?: boolean;
  trialTimeRemaining?: number;
  chainId: number;
  rule?: SQFRule;
}

function formatDate(ts: number, locale: string, noExpiryLabel: string): string {
  if (ts > 4102444800) return noExpiryLabel;
  return new Date(ts * 1000).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function truncate(addr?: string): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * The fee this market actually charges, not a guess from its stage.
 *
 * The rate comes from on-chain config: the venues carry separate rates
 * (`amm_fee_bps` / `book_fee_bps`), so any stage-derived guess would display
 * a rate other than the one the program charges.
 *
 * Falls back to an em dash rather than a plausible number: showing no fee is
 * honest about not knowing, showing "5%" is not.
 */
function getFeeLabel(currentFeeBps?: bigint | number): string {
  if (currentFeeBps === undefined || currentFeeBps === null) return "—";
  const bps = Number(currentFeeBps);
  if (!Number.isFinite(bps)) return "—";
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`;
}

// ─── Rule field extraction (inline label/value pairs) ─────────────────────
function extractRuleFields(
  rule: SQFRule,
): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const [k, v] of Object.entries(rule)) {
    if (k === "description") continue;
    const value = String(v);
    if (value.length > 0) out.push({ label: k, value });
  }
  return out;
}

// ─── Main component ──────────────────────────────────────────────────────
export const MarketDetailsCard = ({
  address,
  symbol,
  creator,
  adjudicator,
  deadline,
  stage,
  isGraduated,
  currentFeeBps,
  isInTrialPeriod: _isInTrialPeriod,
  trialTimeRemaining: _trialTimeRemaining,
  chainId,
  rule,
}: MarketDetailsCardProps) => {
  const { t, i18n } = useTranslation();
  const hasAdjudicator = !!adjudicator;

  const feeLabel = getFeeLabel(currentFeeBps);
  const displaySymbol = symbol || truncate(address);
  const deadlineStr =
    deadline && deadline > 0
      ? formatDate(
          deadline,
          i18n.language === "zh" ? "zh-CN" : "en-US",
          t("marketsPage.noExpiry"),
        )
      : null;

  const ruleFields = rule ? extractRuleFields(rule) : [];
  const hasInlineRule = ruleFields.length > 0;
  const description = rule?.description;

  return (
    <div className="bg-raised px-4 py-3 space-y-1">
      {/* Line 1 — chips */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink">
          <StageBadge stage={stage} />
          <span className="text-faint">·</span>
          <span>{t("marketDetails.feeLabel", { fee: feeLabel })}</span>
        </span>

        {deadlineStr && (
          <div className="flex items-center gap-1.5">
            <Calendar className="w-3 h-3" />
            <span className="font-mono">{deadlineStr}</span>
          </div>
        )}

        <button
          onClick={() => {
            navigator.clipboard.writeText(address);
            toast.success(t("marketDetails.addressCopied"));
          }}
          className="flex items-center gap-1 hover:text-ink transition-colors font-mono cursor-pointer"
          title={t("marketDetails.copyMarketAddress")}
        >
          <Copy className="w-3 h-3" />
          <span>${displaySymbol}</span>
        </button>

        {creator && (
          <a
            href={getAddressExplorerUrl(chainId, creator)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-ink transition-colors font-mono"
            title={t("marketDetails.viewCreator")}
          >
            <User className="w-3 h-3" />
            <span>{truncate(creator)}</span>
          </a>
        )}

        {hasAdjudicator && (
          <a
            href={getAddressExplorerUrl(chainId, adjudicator!)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-ink transition-colors font-mono"
            title={t("marketDetails.viewAdjudicator")}
          >
            <Shield className="w-3 h-3" />
            <span>{truncate(adjudicator)}</span>
            <AdjudicatorScoreInline authority={adjudicator} />
          </a>
        )}
      </div>

      {/* Line 2 — inline rule fields */}
      {hasInlineRule ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {ruleFields.map((f, i) => (
            <span key={i} className="inline-flex items-baseline gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
                {f.label}
              </span>
              <span className="font-mono text-ink break-all">{f.value}</span>
              {i < ruleFields.length - 1 && (
                <span className="text-faint ml-1">·</span>
              )}
            </span>
          ))}
        </div>
      ) : description ? (
        <div className="text-xs text-muted leading-relaxed">
          {description}
        </div>
      ) : null}

    </div>
  );
};

/** The trust tier, inline where the adjudicator is named. Renders nothing
 *  without history — absence of a record IS the information there. */
function AdjudicatorScoreInline({ authority }: { authority?: string }) {
  const score = useAdjudicatorScore(authority ?? null);
  if (!score) return null;
  return <AdjudicatorTierChip score={score} />;
}
