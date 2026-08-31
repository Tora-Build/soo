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
      {/* Reads as a control, not a caption: accent border and tint, a
          filled icon chip, and an explicit VIEW affordance on the right.
          The first version was a bordered row in the page's own palette,
          which is indistinguishable from the read-only cards above it —
          nobody clicks what looks like a heading. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="lp-backers-button"
        className="group w-full flex items-center gap-3 px-4 py-3 border border-accent/40 bg-accent-muted/20 hover:bg-accent-muted/40 hover:border-accent transition-all text-left"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <CircleDollarSign className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">
            {t("lp.backersTitle", { defaultValue: "Liquidity backers" })}
          </span>
          <span className="block text-xs text-muted">
            {t("lp.backersSubtitle", {
              defaultValue: "Who backs this market, and what their LP redeems for",
            })}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-accent">
          {t("lp.backersCta", { defaultValue: "View" })}
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
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
                "LP here is never deposited. The creator seeds it at launch, and every pre-graduation AMM trade mints the trader LP equal to the fee they just paid — a rebate, not a purchase. It unlocks for redemption once the market graduates, settles, or is dismissed, and pays out against the vault between its floor and ceiling.",
            })}
          </p>
          <LPHolders marketAddress={marketAddress} />
        </div>
      </Drawer>
    </>
  );
}
