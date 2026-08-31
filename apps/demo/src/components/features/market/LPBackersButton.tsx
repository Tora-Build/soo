/**
 * "Who backs this market" — a button, not a panel.
 *
 * The LP-holders breakdown is genuinely useful and genuinely secondary: a
 * market page exists to be traded, and a 400-line liquidity panel above the
 * trade form pushed the product's whole purpose below the fold. It lives
 * behind one compact button now, opening a drawer that explains what LP even
 * IS here before showing the numbers — Soo mints LP to every AMM buyer as a
 * side effect of trading, which is unusual enough that a table of holders
 * means nothing without the sentence.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleDollarSign, ChevronRight } from "lucide-react";

import { Drawer } from "../../ui/Drawer";
import { LPHolders } from "../LPHolders";

export function LPBackersButton({
  marketAddress,
}: {
  marketAddress: `0x${string}`;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="lp-backers-button"
        className="w-full flex items-center gap-2.5 px-4 py-3 border border-rule bg-raised hover:border-accent/50 hover:bg-inset transition-all text-left"
      >
        <CircleDollarSign className="h-4 w-4 text-accent shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">
            {t("lp.backersTitle", { defaultValue: "Liquidity backers" })}
          </span>
          <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
            {t("lp.backersSubtitle", {
              defaultValue: "Who holds this market's LP, and what it redeems for",
            })}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 text-faint shrink-0" />
      </button>

      <Drawer
        isOpen={open}
        onClose={() => setOpen(false)}
        title={t("lp.backersTitle", { defaultValue: "Liquidity backers" })}
        maxWidth="max-w-lg"
      >
        <div className="space-y-4">
          {/* The sentence that makes the table legible. Without it, a reader
              who knows DeFi assumes these people DEPOSITED — and then cannot
              find the deposit button, because there isn't one. */}
          <p className="text-sm text-muted leading-relaxed border border-rule bg-inset p-3">
            {t("lp.backersExplainer", {
              defaultValue:
                "LP here is not deposited — it is minted to every AMM buyer as they trade, plus the creator's seed at launch. It earns a share of fees and redeems against the market's floor and ceiling once the outcome settles.",
            })}
          </p>
          <LPHolders marketAddress={marketAddress} />
        </div>
      </Drawer>
    </>
  );
}
