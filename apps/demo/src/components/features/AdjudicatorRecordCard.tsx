/**
 * An adjudicator's track record, shown wherever someone is about to trust one.
 *
 * The tier is never shown without its evidence: a naked "trusted" badge asks
 * for faith, which is the one thing a reputation system exists to replace.
 * Every number here is recomputable from public chain state.
 */
import { useTranslation } from "react-i18next";
import { ShieldCheck, ShieldAlert, ShieldQuestion, Shield } from "lucide-react";
import { traitsOf } from "@sooth/sdk-solana";
import type { AdjudicatorScore, TrustTier } from "@sooth/sdk-solana";

import { useAdjudicatorScore } from "../../features/arena/useAdjudicatorScores";
import { cn } from "../../lib/utils";

const TIER_STYLE: Record<
  TrustTier,
  { label: string; className: string; Icon: typeof Shield }
> = {
  trusted: {
    label: "TRUSTED",
    className: "border-emerald-500/60 text-emerald-400",
    Icon: ShieldCheck,
  },
  standing: {
    label: "IN STANDING",
    className: "border-sky-500/60 text-sky-400",
    Icon: Shield,
  },
  caution: {
    label: "CAUTION",
    className: "border-red-500/60 text-red-400",
    Icon: ShieldAlert,
  },
  unproven: {
    label: "UNPROVEN",
    className: "border-rule text-muted",
    Icon: ShieldQuestion,
  },
};

export function AdjudicatorTierChip({ score }: { score: AdjudicatorScore }) {
  const { label, className, Icon } = TIER_STYLE[score.tier];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em]",
        className,
      )}
      title={`Adjudicator score ${score.score}/100 over ${score.record.resolvedRulings} resolved rulings`}
    >
      <Icon className="h-3 w-3" />
      {label} · {score.score}
    </span>
  );
}

function fmtResponse(sec: number | null): string {
  if (sec === null) return "—";
  if (sec === 0) return "instant";
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

export function AdjudicatorRecordCard({
  authority,
  headline,
}: {
  authority: string | null | undefined;
  /** Context line above the record, e.g. "You will adjudicate this market". */
  headline?: string;
}) {
  const { t } = useTranslation();
  const score = useAdjudicatorScore(authority);

  return (
    <div
      className="border border-rule bg-inset px-3 py-2 space-y-1.5"
      data-testid="adjudicator-record-card"
    >
      {headline && (
        <p className="text-xs text-muted leading-snug">{headline}</p>
      )}
      {!score ? (
        <p className="font-mono text-[11px] text-faint">
          {t("adjudicator.noRecord", {
            defaultValue:
              "No adjudication history on this chain yet — traders will see an UNPROVEN badge until rulings accumulate.",
          })}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <AdjudicatorTierChip score={score} />
            <span className="font-mono text-[10px] text-faint">
              {score.record.authority.slice(0, 4)}…
              {score.record.authority.slice(-4)}
            </span>
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
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted">
            <span>{score.record.resolvedRulings} resolved</span>
            <span className="text-emerald-400">
              {score.record.cleanRulings} clean
            </span>
            {score.record.overriddenRulings > 0 && (
              <span className="text-red-400">
                {score.record.overriddenRulings} vetoed
              </span>
            )}
            {score.record.forcedInvalids > 0 && (
              <span className="text-amber-400">
                {score.record.forcedInvalids} forced invalid
              </span>
            )}
            {score.record.unresponsive > 0 && (
              <span className="text-amber-400">
                {score.record.unresponsive} unresponsive
              </span>
            )}
            <span>rules in {fmtResponse(score.record.medianResponseSec)}</span>
            {score.record.vetoesIssued > 0 && (
              <span>
                {score.record.vetoesIssued} vetoes issued
                {score.record.vetoesOverProof > 0 &&
                  ` (${score.record.vetoesOverProof} over proofs)`}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
