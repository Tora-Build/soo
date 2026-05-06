import { useState } from "react";
import {
  AlertTriangle,
  Shield,
  TrendingDown,
  Bug,
  Calculator,
  CheckCircle,
  ChevronDown,
} from "lucide-react";
import { cn } from "../../../lib/utils";
import { useTranslation } from "react-i18next";

const RISK_IDS = ["lowVolume", "settlement", "smartContract"] as const;

const RISK_META: Record<
  string,
  { likelihood: string; impact: string; icon: "volume" | "shield" | "bug" }
> = {
  lowVolume: { likelihood: "medium", impact: "high", icon: "volume" },
  settlement: { likelihood: "low", impact: "medium", icon: "shield" },
  smartContract: { likelihood: "low", impact: "critical", icon: "bug" },
};

const getLikelihoodColor = (likelihood: string) => {
  switch (likelihood) {
    case "low":
      return "text-ink bg-accent-muted";
    case "medium":
      return "text-accent bg-accent-muted";
    case "high":
      return "text-error bg-raised";
    default:
      return "text-muted bg-ink/5";
  }
};

const getImpactColor = (impact: string) => {
  switch (impact) {
    case "low":
      return "text-ink";
    case "medium":
    case "high":
      return "text-accent";
    case "critical":
      return "text-error";
    default:
      return "text-muted";
  }
};

interface RiskDisclosureProps {
  className?: string;
  collapsed?: boolean;
}

export const RiskDisclosure = ({
  className,
  collapsed = false,
}: RiskDisclosureProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(!collapsed);

  return (
    <div className={cn("", className)}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between gap-3 p-4 bg-ink/5 border border-rule hover:bg-ink/[0.07] hover:border-accent transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-raised border border-rule flex items-center justify-center">
            <AlertTriangle className="w-4 h-4 text-accent" />
          </div>
          <div className="text-left">
            <h3 className="text-sm font-bold text-ink">{t("risk.title")}</h3>
            <p className="text-xs text-muted">{t("risk.subtitle")}</p>
          </div>
        </div>
        <ChevronDown
          className={cn(
            "w-5 h-5 text-faint transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {isOpen && (
        <div className="mt-3 space-y-3">
          {RISK_IDS.map((riskId) => {
            const meta = RISK_META[riskId];
            return (
              <div
                key={riskId}
                className="p-4 bg-ink/5 border border-rule space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      {meta.icon === "bug" ? (
                        <Bug className="w-4 h-4 text-error" />
                      ) : meta.icon === "volume" ? (
                        <TrendingDown className="w-4 h-4 text-accent" />
                      ) : (
                        <Shield className="w-4 h-4 text-accent" />
                      )}
                      <span className="font-bold text-ink text-sm">
                        {t(`risk.${riskId}.title`)}
                      </span>
                    </div>
                    <p className="text-xs text-muted mt-1">
                      {t(`risk.${riskId}.description`)}
                    </p>
                  </div>

                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span
                      className={cn(
                        "text-xs px-2 py-0.5 rounded-full font-bold uppercase",
                        getLikelihoodColor(meta.likelihood),
                      )}
                    >
                      {t(`risk.likelihood.${meta.likelihood}`)}
                    </span>
                    <span
                      className={cn(
                        "text-xs font-bold uppercase",
                        getImpactColor(meta.impact),
                      )}
                    >
                      {meta.impact} {t("risk.impact")}
                    </span>
                  </div>
                </div>

                <div className="flex items-start gap-2 p-2 bg-accent-muted border border-accent">
                  <Shield className="w-3 h-3 text-ink shrink-0 mt-0.5" />
                  <p className="text-xs text-ink">
                    <span className="font-bold">
                      {t("risk.mitigationLabel")}
                    </span>{" "}
                    {t(`risk.${riskId}.mitigation`)}
                  </p>
                </div>
              </div>
            );
          })}

          <div className="p-4 bg-raised border border-rule space-y-3">
            <div className="flex items-center gap-2">
              <Calculator className="w-4 h-4 text-accent" />
              <span className="font-bold text-ink text-sm">
                {t("risk.floorProtection")}
              </span>
            </div>

            <p className="text-xs text-muted">
              {t("risk.floorDescription")}
            </p>

            <div className="p-3 bg-inset/50 font-mono text-sm">
              <span className="text-accent">Floor</span>
              <span className="text-muted"> = </span>
              <span className="text-ink">Cash</span>
              <span className="text-muted"> - </span>
              <span className="text-accent">max(qYes, qNo)</span>
            </div>

            <p className="text-xs text-muted">
              {t("risk.floorWorstCase")}
            </p>
          </div>

          <div className="p-4 bg-ink/5 border border-rule space-y-2">
            <p className="font-mono text-xs text-muted uppercase tracking-[0.12em] tracking-wider">
              {t("risk.acknowledge")}
            </p>

            <div className="space-y-1">
              {(["ack1", "ack2", "ack3"] as const).map((key) => (
                <div
                  key={key}
                  className="flex items-center gap-2 text-xs text-muted"
                >
                  <CheckCircle className="w-3 h-3 text-ink shrink-0" />
                  <span>{t(`risk.${key}`)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
