import {
  Flame,
  Radio,
  CheckCircle2,
  ShieldCheck,
  XCircle,
  Hourglass,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { SimpleTooltip } from "./SimpleTooltip";

/**
 * Canonical stage labels + colors. The indexer / SDK maps protocol state
 * to these keys:
 *   settled  → user label "Resolved"  (outcome decided, unredeemable yet)
 *   finalized → user label "Settled"   (payouts live)
 *
 * Mirror these keys exactly in any place that filters by stage so the UI
 * stays in sync with the canonical map here.
 */
const STAGE_CONFIG: Record<
  string,
  { label: string; color: string; icon: LucideIcon; tip: string }
> = {
  bonding: {
    label: "Bonding",
    color: "text-accent",
    icon: Flame,
    tip: "Bonding phase — trade to help graduate and earn LP tokens",
  },
  expired: {
    label: "Expired",
    color: "text-faint",
    icon: Hourglass,
    tip: "Trial period ended without graduation. Trading still allowed via the AMM — a late rush of fees can still graduate the market.",
  },
  live: {
    label: "Live",
    color: "text-accent",
    icon: Radio,
    tip: "Graduated — active trading with 1% fees",
  },
  settled: {
    label: "Resolved",
    color: "text-muted",
    icon: CheckCircle2,
    tip: "Outcome decided — awaiting finalization",
  },
  finalized: {
    label: "Settled",
    color: "text-muted",
    icon: ShieldCheck,
    tip: "Settled — redeem winning shares for USDC",
  },
  dismissed: {
    label: "Dismissed",
    color: "text-faint",
    icon: XCircle,
    tip: "Dismissed — refunds available",
  },
};

interface StageBadgeProps {
  stage: string;
  className?: string;
}

export const StageBadge = ({ stage, className }: StageBadgeProps) => {
  const { t } = useTranslation();
  const config = STAGE_CONFIG[stage] ?? STAGE_CONFIG.bonding;
  const Icon = config.icon;
  const labelKey = `stage.${stage === "expired" ? "expired" : stage}`;
  const tipKey = `stageBadge.${stage === "expired" ? "expired" : stage}.tip`;
  return (
    <SimpleTooltip content={t(tipKey, { defaultValue: config.tip })}>
      <span
        className={cn(
          "inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] cursor-help",
          config.color,
          className,
        )}
      >
        {stage === "live"
          ? <span className="stage-live-dot" aria-hidden="true" />
          : <Icon className="w-3 h-3" />}
        {t(labelKey, { defaultValue: config.label })}
      </span>
    </SimpleTooltip>
  );
};

export { STAGE_CONFIG };
