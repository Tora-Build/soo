/**
 * MarketDetailsCard — flat 4-line layout for AMM/Orderbook surfaces.
 *
 * Line 1: stage · fee · deadline · $market · creator · adjudicator (chips)
 * Line 2: market question
 * Line 3: structured rule fields, inline (Source / Params / Condition / …)
 * Line 4: adjudicator type badges (Web2 API Prove · Primus · 2.5% fee)
 */
import { Shield, Calendar, User, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "react-hot-toast";
import type { SQFRule } from "../../../lib/sqf";
import {
  getAdjudicatorByAddress,
  type AdjudicatorType,
} from "../../../config/registries";
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
  isInTrialPeriod?: boolean;
  trialTimeRemaining?: number;
  chainId: number;
  rule?: SQFRule;
}

const TYPE_LABEL_KEYS: Record<AdjudicatorType, string> = {
  ZK_ORACLE: "marketDetails.types.zkOracle",
  ZK_RULE: "marketDetails.types.zkRule",
  AI_AGENT: "marketDetails.types.aiAgent",
  OPTIMISTIC: "marketDetails.types.optimistic",
};

function formatDuration(seconds: string | number): string {
  const n = typeof seconds === "number" ? seconds : Number(seconds);
  if (!Number.isFinite(n)) return String(seconds);
  if (n >= 86400)
    return `${Math.floor(n / 86400)}d ${Math.floor((n % 86400) / 3600)}h`;
  if (n >= 3600)
    return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
  return `${Math.floor(n / 60)}m`;
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

function getFeeLabel(stage: string, isGraduated?: boolean): string {
  if (stage === "settled" || stage === "finalized" || isGraduated) return "1%";
  return "5%";
}

// ─── Rule field extraction (type-aware, returns inline label/value pairs) ──
function extractRuleFields(
  rule: SQFRule,
  type?: AdjudicatorType,
  t?: (key: string, options?: Record<string, unknown>) => string,
): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string | number | undefined) => {
    if (value !== undefined && value !== null && String(value).length > 0)
      out.push({ label, value: String(value) });
  };

  if (type === "ZK_ORACLE") {
    push(t?.("marketDetails.rule.source") ?? "Source", rule.source);
    if (rule.adapter && rule.adapter !== rule.source)
      push(t?.("marketDetails.rule.adapter") ?? "Adapter", rule.adapter);
    push(t?.("marketDetails.rule.params") ?? "Params", rule.params);
    if (rule.op && rule.target)
      push(
        t?.("marketDetails.rule.condition") ?? "Condition",
        `${rule.op.toUpperCase()} ${rule.target}`,
      );
  } else if (type === "ZK_RULE") {
    push(t?.("marketDetails.rule.contract") ?? "Contract", rule.contract);
    push(t?.("marketDetails.rule.event") ?? "Event", rule.event);
    push(t?.("marketDetails.rule.condition") ?? "Condition", rule.condition);
    push(t?.("marketDetails.rule.chain") ?? "Chain", rule.chain);
  } else if (type === "AI_AGENT") {
    push(t?.("marketDetails.rule.agent") ?? "Agent", rule["agent-id"]);
    if (rule["min-validators"])
      push(
        t?.("marketDetails.rule.validators") ?? "Validators",
        `${rule["min-validators"]} ${t?.("marketDetails.min") ?? "min"}`,
      );
    push(t?.("marketDetails.rule.prompt") ?? "Prompt", rule.prompt);
  } else if (type === "OPTIMISTIC") {
    if (rule.bond) push(t?.("marketDetails.rule.bond") ?? "Bond", `${rule.bond} USDC`);
    if (rule["dispute-window"])
      push(
        t?.("marketDetails.rule.dispute") ?? "Dispute",
        `${formatDuration(rule["dispute-window"])} ${t?.("marketDetails.window") ?? "window"}`,
      );
  } else {
    for (const [k, v] of Object.entries(rule)) {
      if (k === "description") continue;
      push(k, String(v));
    }
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
  isInTrialPeriod: _isInTrialPeriod,
  trialTimeRemaining: _trialTimeRemaining,
  chainId,
  rule,
}: MarketDetailsCardProps) => {
  const { t, i18n } = useTranslation();
  const adjOption = getAdjudicatorByAddress(adjudicator, chainId);
  const hasAdjudicator =
    !!adjudicator &&
    adjudicator !== "0x0000000000000000000000000000000000000000";

  const type = adjOption?.type;
  const typeLabel = type ? t(TYPE_LABEL_KEYS[type]) : null;
  const feeLabel = getFeeLabel(stage, isGraduated);
  const displaySymbol = symbol || truncate(address);
  const deadlineStr =
    deadline && deadline > 0
      ? formatDate(
          deadline,
          i18n.language === "zh" ? "zh-CN" : "en-US",
          t("marketsPage.noExpiry"),
        )
      : null;

  const ruleFields = rule ? extractRuleFields(rule, type, t) : [];
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

      {/* Line 3 — adjudicator badges + type tag */}
      {(adjOption || typeLabel) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
          {adjOption && (
            <span>
              {adjOption.badges.join(" · ")} ·{" "}
              {t("marketDetails.feeSuffix", { fee: adjOption.fee })}
            </span>
          )}
          {typeLabel && <span className="text-accent">{typeLabel}</span>}
        </div>
      )}
    </div>
  );
};
