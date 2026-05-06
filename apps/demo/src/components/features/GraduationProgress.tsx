// GraduationProgress.tsx - Bonding curve progress card for Launchpad markets
// Graduation is based on FEES ACCRUED, not initial liquidity.

import React from "react";
import { formatUnits } from "@/lib/chain-shim";
import { TrendingUp, Trophy, Loader2, Clock } from "lucide-react";
import { useTranslation } from "react-i18next";

interface GraduationProgressProps {
  feesAccrued: bigint;
  graduationThreshold: bigint;
  graduationProgress?: number;
  isGraduated: boolean;
  canGraduate?: boolean;
  onGraduate?: () => void;
  isGraduatePending?: boolean;
  isInTrialPeriod?: boolean;
  trialTimeRemaining?: number;
  isDismissed?: boolean;
  /**
   * Current yesProbability (0–1) from the AMM. Combined with
   * feesAccrued === 0 this exposes the creator's chosen starting
   * probability — because LMSR seeding is a system op that charges
   * no fee, the current price is still the seed until someone trades.
   */
  currentYesPrice?: number;
}

const formatTrialTime = (seconds: number) => {
  if (seconds <= 0) return "Ended";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
};

export const GraduationProgress: React.FC<GraduationProgressProps> = ({
  feesAccrued,
  graduationThreshold,
  graduationProgress,
  isGraduated,
  canGraduate: canGraduateProp,
  onGraduate,
  isGraduatePending,
  isInTrialPeriod,
  trialTimeRemaining,
  isDismissed,
  currentYesPrice,
}) => {
  const { t } = useTranslation();
  const feesVal = feesAccrued ? parseFloat(formatUnits(feesAccrued, 18)) : 0;
  const thresholdVal = graduationThreshold
    ? parseFloat(formatUnits(graduationThreshold, 18))
    : 10000;
  const progressPercent =
    graduationProgress ??
    (thresholdVal > 0 ? Math.min((feesVal / thresholdVal) * 100, 100) : 0);
  const canGraduate =
    canGraduateProp ?? (progressPercent >= 100 && !isGraduated);
  const remaining = Math.max(0, thresholdVal - feesVal);

  if (isGraduated) return null;

  return (
    <div className="border border-rule bg-raised">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-rule">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-ink" />
          <h2 className="text-lg font-bold text-ink">{t("bonding.title")}</h2>
        </div>
        <div className="flex items-center gap-2">
          {isInTrialPeriod && !isDismissed && (
            <div className="flex items-center gap-1">
              <Clock className="w-3 h-3 text-accent" />
              <span className="font-mono text-xs text-accent tabular-nums">
                {formatTrialTime(trialTimeRemaining || 0)}
              </span>
            </div>
          )}
          <span className="font-mono text-xl font-bold text-accent tabular-nums">
            {progressPercent.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* 3 stat components — flush cells (no inter-cell divider). */}
      <div className="flex">
        <div className="flex-1 bg-raised px-3 py-2 text-left">
          <div className="font-mono text-xs uppercase tracking-[0.12em] text-faint mb-0.5">
            {t("bonding.feesAccrued")}
          </div>
          <div className="font-mono text-sm font-semibold text-ink tabular-nums">
            ${feesVal.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="flex-1 bg-raised px-3 py-2 text-center">
          <div className="font-mono text-xs uppercase tracking-[0.12em] text-faint mb-0.5">
            {t("bonding.toGraduation")}
          </div>
          <div className="font-mono text-sm font-semibold text-ink tabular-nums flex items-center justify-center gap-1">
            <TrendingUp size={11} className="text-faint" />$
            {remaining.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
        </div>
        <div className="flex-1 bg-raised px-3 py-2 text-right">
          <div className="font-mono text-xs uppercase tracking-[0.12em] text-faint mb-0.5">
            {t("bonding.target")}
          </div>
          <div className="font-mono text-sm font-semibold text-ink tabular-nums">
            $
            {thresholdVal.toLocaleString(undefined, {
              maximumFractionDigits: 0,
            })}
          </div>
        </div>
      </div>

      {/* Progress bar line */}
      <div className="relative h-1.5 bg-rule">
        <div
          className="absolute inset-y-0 left-0 bg-accent transition-all duration-700 ease-out"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Untraded / creator-seed note — resolves the "75% price but 0%
          graduation" paradox. Only rendered when feesAccrued === 0 (no
          trades have happened yet), so the current yesProbability is
          still the creator's chosen initialProbabilityWad. After the
          first trade the note disappears because feesAccrued > 0. */}
      {feesAccrued === 0n && currentYesPrice !== undefined && (
        <div className="flex items-center gap-2 px-4 py-2 bg-inset/40">
          <Clock className="w-3 h-3 text-faint shrink-0" />
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
            Untraded — seeded by creator at
          </span>
          <span className="font-mono text-[10px] font-bold text-accent tabular-nums">
            {Math.round(currentYesPrice * 100)}% YES
          </span>
        </div>
      )}

      {/* Graduate CTA */}
      {canGraduate && onGraduate && (
        <div className="p-3">
          <button
            onClick={onGraduate}
            disabled={isGraduatePending}
            className="btn btn-primary w-full py-2.5 disabled:opacity-50 flex items-center justify-center gap-2 font-mono text-xs uppercase tracking-[0.12em] font-bold"
          >
            {isGraduatePending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t("bonding.graduating")}
              </>
            ) : (
              <>
                <Trophy size={14} />
                {t("bonding.graduateMarket")}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};
