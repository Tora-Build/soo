// The pre-graduation trade surface — upstream's drawer design, made real.
//
// The reference deployment's drawer shows a clean YES-denominated panel:
// Buy YES / Sell YES, price in cents, shares, cost, one action. Our port had
// been embedding the classic demo's trading panel here instead — the exact
// "design we had before" this drawer exists to replace. This is the upstream
// panel's shape wired to the chain: quotes from the program's own LMSR via
// the adapter (no RPC on keystroke — the quote is a read), execution one
// signature, and the Solana truths stated where they bite (sell proceeds
// unlock after the cooldown; there is no approval step to show).
//
// One axis, YES-denominated, exactly like upstream: Buy YES opens exposure,
// Sell YES closes it. "Buy NO" is not a third thing — it is the same axis
// walked the other way, and the panel says so instead of pretending.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDemo } from "../../../lib/DemoContext";
import { tokenSymbols } from "../../../lib/config";
import type { OptionChainCell } from "../../hooks/useOptionChain";

const WAD = 10n ** 18n;
const PRESETS = [5n, 10n, 25n];

function centsOf(wad: bigint): string {
  const c = Number((wad * 1000n) / WAD) / 10;
  return `${c % 1 === 0 ? c.toFixed(0) : c.toFixed(1)}¢`;
}

export function BondingTrade({ cell }: { cell: OptionChainCell }) {
  const { t } = useTranslation();
  const demo = useDemo();
  const ref = cell.marketAddress
    ? `sol:${cell.marketAddress.replace(/^0x/, "")}`
    : null;

  const [action, setAction] = useState<"buy" | "sell">("buy");
  const [shares, setShares] = useState(10n);
  const [quote, setQuote] = useState<{ cost: bigint; fee: bigint } | null>(null);
  const [position, setPosition] = useState<{ yes: bigint; no: bigint } | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"pos" | "neg">("pos");

  const yesPriceWad = cell.yesPriceWad ?? WAD / 2n;

  // Live quote — the program's own arithmetic, read not guessed.
  useEffect(() => {
    let stale = false;
    if (!demo?.adapter || !ref) return;
    const delta = action === "buy" ? shares * WAD : -(shares * WAD);
    demo.adapter
      .readQuote(ref, 1, delta)
      .then((q) => {
        if (!stale) setQuote({ cost: q.cost, fee: q.fee });
      })
      .catch(() => {
        if (!stale) setQuote(null);
      });
    return () => {
      stale = true;
    };
  }, [demo, ref, action, shares]);

  // The trader's current exposure, for the sell path's reality check.
  useEffect(() => {
    let stale = false;
    if (!demo?.adapter || !ref || !demo.userRef) return;
    demo.adapter
      .readPosition(ref, demo.userRef)
      .then((p) => {
        if (!stale)
          setPosition({ yes: p.yesShares ?? 0n, no: p.noShares ?? 0n });
      })
      .catch(() => {
        if (!stale) setPosition({ yes: 0n, no: 0n });
      });
    return () => {
      stale = true;
    };
  }, [demo, ref, pending]);

  const costAbs = useMemo(() => {
    if (!quote) return null;
    const gross = quote.cost < 0n ? -quote.cost : quote.cost;
    return action === "buy" ? gross + quote.fee : gross - quote.fee;
  }, [quote, action]);

  const sellTooLarge =
    action === "sell" && position !== null && shares * WAD > position.yes;

  const submit = async () => {
    if (!demo?.adapter || !ref || !demo.userRef || !demo.signer) {
      setMessage(t("eastboard.trade.real.connect"));
      setMessageTone("neg");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const req =
        action === "buy"
          ? await demo.adapter.buildTrade(ref, {
              side: "buy",
              outcome: 1,
              deltaShares: shares * WAD,
              maxCostWad: shares * WAD, // 1.00/share definitional ceiling
              user: demo.userRef,
            } as never)
          : await demo.adapter.buildSell(ref, {
              outcome: 1,
              deltaShares: shares * WAD,
              user: demo.userRef,
            });
      await demo.adapter.submit(req, demo.signer as never);
      setMessageTone("pos");
      setMessage(
        action === "buy"
          ? t("eastboard.trade.real.bought", { shares: String(shares) })
          : t("eastboard.trade.real.sold", { shares: String(shares) }),
      );
    } catch (e) {
      setMessageTone("neg");
      setMessage(e instanceof Error ? e.message.slice(0, 140) : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      {/* left: the market's state, plainly */}
      <section>
        <div className="border-b border-rule pb-3">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-muted">
            {t("eastboard.trade.real.priceTitle")}
          </span>
        </div>
        <div className="mt-4 flex items-baseline gap-4">
          <span className="font-mono text-5xl font-bold text-pos">
            {centsOf(yesPriceWad)}
          </span>
          <span className="font-mono text-sm text-muted">YES</span>
          <span className="ml-auto font-mono text-lg text-neg">
            {centsOf(WAD - yesPriceWad)} NO
          </span>
        </div>
        <div className="mt-3 flex h-1.5 overflow-hidden">
          <div
            className="bg-pos"
            style={{ width: `${Number((yesPriceWad * 100n) / WAD)}%` }}
          />
          <div className="flex-1 bg-neg/60" />
        </div>
        <p className="mt-4 text-[11px] leading-relaxed text-muted">
          {t("eastboard.trade.real.axisNote", { symbol: tokenSymbols.amm })}
        </p>
        {position && (position.yes > 0n || position.no > 0n) && (
          <div className="mt-4 border border-rule bg-inset p-3 font-mono text-[11px]">
            <span className="text-faint">
              {t("eastboard.trade.real.yourPosition")}{" "}
            </span>
            {position.yes > 0n && (
              <span className="text-pos">
                YES {(Number(position.yes) / 1e18).toFixed(1)}{" "}
              </span>
            )}
            {position.no > 0n && (
              <span className="text-neg">
                NO {(Number(position.no) / 1e18).toFixed(1)}
              </span>
            )}
          </div>
        )}
      </section>

      {/* right: the whole trade — action, size, cost, one button */}
      <section className="border border-rule bg-raised p-4">
        <div className="grid grid-cols-2 gap-1 border border-rule bg-inset p-1">
          <button
            type="button"
            onClick={() => setAction("buy")}
            className={`px-2 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] transition-colors ${
              action === "buy" ? "bg-pos text-canvas" : "text-muted hover:text-ink"
            }`}
          >
            {t("eastboard.trade.real.buyYes")}
          </button>
          <button
            type="button"
            onClick={() => setAction("sell")}
            className={`px-2 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] transition-colors ${
              action === "sell" ? "bg-neg text-canvas" : "text-muted hover:text-ink"
            }`}
          >
            {t("eastboard.trade.real.sellYes")}
          </button>
        </div>

        <label className="mt-4 block font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
          {t("eastboard.trade.real.shares")}
        </label>
        <div className="mt-1 flex gap-1">
          {PRESETS.map((p) => (
            <button
              key={String(p)}
              type="button"
              onClick={() => setShares(p)}
              className={`flex-1 border px-2 py-1.5 font-mono text-xs ${
                shares === p
                  ? "border-rule bg-inset text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {String(p)}
            </button>
          ))}
          <input
            type="number"
            min={1}
            value={String(shares)}
            onChange={(e) => {
              const v = BigInt(Math.max(1, Math.floor(Number(e.target.value) || 1)));
              setShares(v);
            }}
            className="w-16 border border-rule bg-inset px-2 py-1.5 text-right font-mono text-xs text-ink outline-none focus:border-accent"
          />
        </div>

        <dl className="mt-4 space-y-1.5 border-t border-rule pt-3 font-mono text-[11px]">
          <div className="flex justify-between">
            <dt className="text-faint">
              {action === "buy"
                ? t("eastboard.trade.real.cost")
                : t("eastboard.trade.real.proceeds")}
            </dt>
            <dd className="text-ink">
              {costAbs === null
                ? "…"
                : `${(Number(costAbs) / 1e18).toFixed(2)} ${tokenSymbols.amm}`}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-faint">{t("eastboard.trade.real.paysIfYes")}</dt>
            <dd className="text-pos">
              {String(shares)} {tokenSymbols.amm}
            </dd>
          </div>
        </dl>

        {action === "sell" && (
          <p className="mt-3 border border-warn/40 bg-warn-soft p-2 font-mono text-[10px] leading-relaxed text-warn">
            {t("eastboard.trade.real.cooldownNote")}
          </p>
        )}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={pending || sellTooLarge}
          className={`mt-4 w-full py-3 font-mono text-xs font-bold uppercase tracking-[0.1em] text-canvas transition-opacity disabled:opacity-40 ${
            action === "buy" ? "bg-pos" : "bg-neg"
          }`}
        >
          {pending
            ? t("eastboard.trade.real.pending")
            : sellTooLarge
              ? t("eastboard.trade.real.notEnough")
              : action === "buy"
                ? t("eastboard.trade.real.buyCta", { shares: String(shares) })
                : t("eastboard.trade.real.sellCta", { shares: String(shares) })}
        </button>

        {message && (
          <p
            className={`mt-2 font-mono text-[10px] leading-relaxed ${
              messageTone === "pos" ? "text-pos" : "text-neg"
            }`}
          >
            {message}
          </p>
        )}
      </section>
    </div>
  );
}
