// Activation, Solana-shaped.
//
// Activating a cell takes ONE transaction: `create_market` composes the whole
// initialization, and the template's question rides in the instruction,
// verified against its hash by the program. A multi-step wizard for one
// signature would be theater, so this one shows what is actually true: the
// cell's terms, one action, one result.

import { useTranslation } from "react-i18next";

import { tokenSymbols } from "@/lib/config";
import type { OptionTemplate } from "../../core";
import { useCanonicalActivation } from "../../hooks/useCanonicalActivation";
import { useSimulationStore } from "../../store/useSimulationStore";

interface ActivationWizardProps {
  template: OptionTemplate;
  fixtureMode: boolean;
  existingMarketAddress?: `0x${string}`;
  onClose: () => void;
  onTrade: (marketAddress?: `0x${string}`) => void;
}

const WAD = 10n ** 18n;

function formatWadTokens(value: bigint): string {
  const whole = value / WAD;
  const cents = ((value % WAD) * 100n) / WAD;
  return `${whole}.${cents.toString().padStart(2, "0")}`;
}

export function ActivationWizard({
  template,
  fixtureMode,
  existingMarketAddress,
  onClose,
  onTrade,
}: ActivationWizardProps) {
  const { t } = useTranslation();
  const activation = useCanonicalActivation(template, existingMarketAddress);
  const activateFixture = useSimulationStore((state) => state.activate);

  const done = activation.stepState === "done" || !!existingMarketAddress;

  const handleActivate = async () => {
    if (fixtureMode) {
      activateFixture(template);
      onTrade(undefined);
      return;
    }
    await activation.activate();
  };

  return (
    <div className="grid gap-5 p-5 sm:p-6">
      <header className="grid gap-1">
        <h2
          id="activation-title"
          className="font-mono text-xs font-semibold uppercase tracking-[0.15em] text-ink"
        >
          {t("eastboard.activation.title")}
        </h2>
        <p className="text-[11px] leading-relaxed text-muted">
          {template.question}
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-3 border border-rule bg-inset p-4 font-mono text-[10px] uppercase tracking-[0.12em]">
        <div>
          <dt className="text-faint">{t("eastboard.activation.strike")}</dt>
          <dd className="text-ink">{template.strikeLabel}</dd>
        </div>
        <div>
          <dt className="text-faint">{t("eastboard.activation.expiry")}</dt>
          <dd className="text-ink">{template.expiry}</dd>
        </div>
        <div>
          <dt className="text-faint">{t("eastboard.activation.close")}</dt>
          <dd className="text-ink">{template.closeLabel}</dd>
        </div>
        <div>
          <dt className="text-faint">{t("eastboard.activation.liquidity")}</dt>
          {/* b, in the AMM venue's collateral token. */}
          <dd className="text-ink">
            {formatWadTokens(template.bBaseWad)} {tokenSymbols.amm}
          </dd>
        </div>
      </dl>

      {activation.message && (
        <div className="border border-warn/40 bg-warn-soft p-3 font-mono text-[10px] leading-relaxed text-warn">
          {activation.message}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="border border-rule px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted transition-colors hover:text-ink"
        >
          {t("eastboard.activation.cancel")}
        </button>
        {done ? (
          <button
            type="button"
            onClick={() =>
              onTrade(activation.marketAddress ?? existingMarketAddress)
            }
            className="border border-pos/50 bg-pos-soft px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-pos"
          >
            {t("eastboard.activation.trade")}
          </button>
        ) : (
          <button
            type="button"
            disabled={activation.pending || (!fixtureMode && !activation.connected)}
            onClick={handleActivate}
            className="border border-accent/60 bg-accent/10 px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-accent disabled:opacity-40"
          >
            {activation.pending
              ? t("eastboard.activation.pending")
              : fixtureMode
                ? t("eastboard.activation.activateFixture")
                : t("eastboard.activation.activate")}
          </button>
        )}
      </div>
    </div>
  );
}
