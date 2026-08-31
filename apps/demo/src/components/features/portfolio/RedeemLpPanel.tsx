/**
 * Redeem LP — every position the wallet holds, in one place.
 *
 * This panel used to redeem exactly ONE market: whichever arrived in the
 * `?market=` query string, falling back to the single env-seeded market. A
 * holder with LP in five markets could reach one of them, and only by
 * following a link that happened to carry it — while `useLPPositions`, two
 * components up the page, already knew about all five.
 *
 * Redemption lives HERE and not in the market page's liquidity drawer on
 * purpose: the drawer answers "who backs this market" for anyone looking at
 * it, while claiming is a thing you do to your OWN holdings, and holdings
 * belong in the Locker beside every other position.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { Coins, Loader2 } from "lucide-react";

import { useWriteContract } from "@/lib/chain-shim";
import { useLPPositions } from "../../../hooks";
import { Card } from "../../ui/Card";
import { cn } from "../../../lib/utils";

/** 18dp display units → the LP mint's 6dp base units (10^12). */
const LP_DISPLAY_SCALE = 1_000_000_000_000n;

export function RedeemLpPanel() {
  const { t } = useTranslation();
  const { positions, isLoading, refetch } = useLPPositions();
  const { writeContractAsync } = useWriteContract();
  const [busyMarket, setBusyMarket] = useState<string | null>(null);

  const held = useMemo(
    () => positions.filter((p) => p.lpBalance > 0n),
    [positions],
  );

  if (held.length === 0) return null;

  const redeem = async (marketAddress: string, lpBalance: bigint) => {
    setBusyMarket(marketAddress);
    try {
      await writeContractAsync({
        functionName: "redeemLp",
        // Whole balance, in the MINT's base units. The shim reports LP
        // balances scaled to 18dp because every formatter assumes that, but
        // the program takes a u64 of 6dp base units — so passing the display
        // figure straight through overflowed u64 on any balance above ~18 LP
        // and burned 10^12x too much below it. Every Redeem click failed.
        args: [
          `sol:${marketAddress.replace(/^0x/, "")}`,
          lpBalance / LP_DISPLAY_SCALE,
        ],
      } as never);
      toast.success(
        t("lp.redeemed", { defaultValue: "LP redeemed — USDC is in your wallet" }),
      );
      refetch?.();
    } catch (e) {
      toast.error((e as Error).message?.slice(0, 140) ?? "Redeem failed");
    } finally {
      setBusyMarket(null);
    }
  };

  return (
    <Card className="bg-raised border border-rule p-6">
      <div className="flex items-center gap-2 mb-1">
        <Coins className="w-4 h-4 text-accent" />
        <h3 className="text-base font-semibold text-ink">
          {t("lp.redeemTitle", { defaultValue: "Your Liquidity" })}
        </h3>
      </div>
      <p className="text-sm text-muted leading-relaxed mb-4">
        {t("lp.redeemSubtitle", {
          defaultValue:
            "LP you earned by trading or seeding. Redeeming burns it and pays your share of the market's fee pool.",
        })}
      </p>

      <div className="space-y-2" data-testid="lp-redeem-list">
        {held.map((position) => (
          <div
            key={position.marketAddress}
            // The FULL address, so a test (or anything else) can find one
            // market's row without reconstructing a sliced testid.
            data-market={position.marketAddress.replace(/^(0x|sol:)/, "")}
            className="border border-rule bg-inset px-3 py-2.5 flex items-center gap-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink leading-snug line-clamp-1">
                {position.question}
              </p>
              <p className="font-mono text-[10px] text-faint tabular-nums">
                {Number(position.lpBalanceFormatted).toFixed(2)} LP ·{" "}
                {position.sharePercent.toFixed(1)}%{" "}
                {t("lp.ofSupply", { defaultValue: "of supply" })}
              </p>
            </div>
            <button
              type="button"
              disabled={busyMarket !== null}
              onClick={() => redeem(position.marketAddress, position.lpBalance)}
              data-testid={`lp-redeem-${position.marketAddress.slice(0, 8)}`}
              className={cn(
                "shrink-0 px-3 py-1.5 border border-accent bg-accent text-canvas",
                "font-mono text-[10px] font-bold uppercase tracking-[0.12em]",
                "hover:opacity-90 disabled:opacity-50 transition-opacity",
              )}
            >
              {busyMarket === position.marketAddress ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                t("lp.redeemCta", { defaultValue: "Redeem" })
              )}
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}
