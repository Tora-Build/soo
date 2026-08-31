// The veto countdown — shown wherever a market's status is.
//
// Between `attest_outcome` and `settle` a market sits in a state that looks
// like nothing is happening and is in fact the only window in which a wrong
// outcome can be taken back. This badge names it: the outcome that was
// attested, how long the dispute window has left, and — once it runs out —
// that settlement is unlocked and anyone can crank it.
//
// The deadline is `AdjudicatorEntry.attested_at + ProtocolConfig
// .veto_period_secs`, the same sum `settle` compares against, so the number
// on screen is the gate rather than an estimate of it.

import { useEffect, useState } from "react";
import { Gavel, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SimpleTooltip } from "../../ui/SimpleTooltip";
import { cn } from "../../../lib/utils";
import {
  formatCountdown,
  outcomeLabel,
  resolveMarketView,
  type ResolutionView,
} from "../../../features/arena/resolution";
import {
  useMarketResolution,
  useResolutionStates,
} from "../../../features/arena/useResolutionStates";
import { useAccount } from "@/lib/chain-shim";

/** Wall clock in unix seconds, re-rendering once a second. */
export function useNowSec(active = true): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** The resolution view for one market, tied to the connected wallet. */
export function useResolutionView(
  address: string | null | undefined,
): ResolutionView | null {
  const state = useMarketResolution(address);
  const { vetoPeriodSecs, permissionlessAdjudicators } = useResolutionStates();
  const { address: wallet } = useAccount();
  const nowSec = useNowSec(!!state);
  if (!state) return null;
  return resolveMarketView({
    state,
    vetoPeriodSecs,
    permissionlessAdjudicators,
    wallet: wallet ? String(wallet).replace(/^0x/, "") : null,
    nowSec,
  });
}

interface VetoWindowBadgeProps {
  /** Market PDA in any of `0x…` / `sol:…` / bare base58. */
  address: string | null | undefined;
  className?: string;
  /** `inline` is the compact card/row form; `bar` adds a background so it
   *  reads as a status strip in a modal header. */
  variant?: "inline" | "bar";
}

/**
 * Renders nothing unless the market is attested-but-not-settled. That is the
 * point: it is a state marker, not a slot that always occupies space.
 */
export const VetoWindowBadge = ({
  address,
  className,
  variant = "inline",
}: VetoWindowBadgeProps) => {
  const { t } = useTranslation();
  const view = useResolutionView(address);
  if (!view) return null;
  if (view.phase !== "veto" && view.phase !== "settleable") return null;

  const outcome = outcomeLabel(view.attestedOutcome);
  const elapsed = view.phase === "settleable";
  const left = view.vetoSecondsLeft;

  const label = elapsed
    ? t("veto.settleReady", { defaultValue: "SETTLE READY" })
    : t("veto.countdownLabel", { defaultValue: "DISPUTE WINDOW" });

  const tip = elapsed
    ? t("veto.tipElapsed", {
        defaultValue:
          "The dispute window on {{outcome}} has closed. Settlement is unlocked — anyone can crank it, and holders redeem once it lands.",
        outcome,
      })
    : t("veto.tipOpen", {
        defaultValue:
          "{{outcome}} has been attested but not settled. This window is the chance to dispute a wrong outcome; when it ends anyone may settle the market.",
        outcome,
      });

  const Icon = elapsed ? Gavel : ShieldAlert;

  return (
    <SimpleTooltip content={tip}>
      <span
        data-testid="veto-window-badge"
        data-veto-phase={view.phase}
        className={cn(
          "inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] cursor-help tabular-nums",
          elapsed ? "text-accent" : "text-warn",
          variant === "bar" &&
            "border border-current/40 bg-inset px-2 py-1 rounded-none",
          className,
        )}
      >
        <Icon className="w-3 h-3 shrink-0" />
        <span>
          {t("veto.attestedPrefix", {
            defaultValue: "{{outcome}} ·",
            outcome,
          })}
        </span>
        <span>{label}</span>
        {/* The clock keeps its own casing — `05m 45s` reads as a duration,
            `05M 45S` reads as an acronym. */}
        {!elapsed && (
          <span className="normal-case">
            {left === null ? "—" : formatCountdown(left)}
          </span>
        )}
      </span>
    </SimpleTooltip>
  );
};
