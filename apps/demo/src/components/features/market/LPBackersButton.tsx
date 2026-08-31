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
import { Link } from "react-router-dom";
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
      {/* --accent-muted is an 8%-opacity tint, so the previous
          `bg-accent-muted/20` rendered at ~1.6% — invisible on this ground.
          Solid accent carries the affordance instead: a full border, a
          filled icon chip, and a SOLID pill for the action. */}
      <div className="pt-2 border-t border-rule">
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="lp-backers-button"
          className="group w-full flex items-center gap-3 px-4 py-3 border border-accent bg-raised hover:bg-inset transition-all text-left"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-canvas">
            <CircleDollarSign className="h-4.5 w-4.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink">
              {t("lp.backersTitle", { defaultValue: "Liquidity backers" })}
            </span>
            <span className="block text-xs text-muted">
              {t("lp.backersSubtitle", {
                defaultValue: "Who backs this market, and what their LP is worth",
              })}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 bg-accent px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-canvas">
            {t("lp.backersCta", { defaultValue: "View" })}
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </button>
      </div>

      <Drawer
        isOpen={open}
        onClose={() => setOpen(false)}
        title={t("lp.backersTitle", { defaultValue: "Liquidity backers" })}
        maxWidth="max-w-lg"
      >
        <div className="space-y-4">
          {/* One line, not a lecture: the surprising part only. The full
              mechanism lives in the tutorial, where someone reading ABOUT
              the product is actually looking for it. */}
          <p className="text-sm text-muted leading-relaxed">
            {t("lp.backersExplainer", {
              defaultValue:
                "LP is never deposited here — it is minted to traders as a fee rebate, plus the creator's seed.",
            })}{" "}
            <Link
              to="/learn#liquidity"
              className="text-accent hover:underline whitespace-nowrap"
            >
              {t("lp.backersLearnMore", { defaultValue: "How it works →" })}
            </Link>
          </p>
          <LPHolders marketAddress={marketAddress} />
        </div>
      </Drawer>
    </>
  );
}
