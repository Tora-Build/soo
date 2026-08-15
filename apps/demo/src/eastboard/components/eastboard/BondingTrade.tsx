// Pre-graduation trading, one axis, two buttons.
//
// YES and NO are the same curve from opposite ends, so a side press ROUTES
// rather than blocks: hold enough of the opposite side and pressing this one
// closes that exposure (sell, cooldown escrow); otherwise it opens this side
// (buy). "Sell YES without owning YES" is buying NO, and the panel just does
// it instead of explaining it.
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

  const [side, setSide] = useState<1 | 0>(1);
  const [shares, setShares] = useState(10n);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [position, setPosition] = useState({ yes: 0n, no: 0n });
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"pos" | "neg">("pos");

  const yesPriceWad = cell.yesPriceWad ?? WAD / 2n;

  // Routing: pressing a side closes the OPPOSITE exposure when it covers the
  // size, else opens this side.
  const closes = useMemo(() => {
    const opposite = side === 1 ? position.no : position.yes;
    return opposite >= shares * WAD;
  }, [side, shares, position]);

  useEffect(() => {
    let stale = false;
    if (!demo?.adapter || !ref) return;
    const outcome = closes ? (side === 1 ? 0 : 1) : side;
    const delta = closes ? -(shares * WAD) : shares * WAD;
    demo.adapter
      .readQuote(ref, outcome as 0 | 1, delta)
      .then((q) => {
        if (stale) return;
        const gross = q.cost < 0n ? -q.cost : q.cost;
        setQuote(closes ? gross - q.fee : gross + q.fee);
      })
      .catch(() => !stale && setQuote(null));
    return () => {
      stale = true;
    };
  }, [demo, ref, side, shares, closes]);

  useEffect(() => {
    let stale = false;
    if (!demo?.adapter || !ref || !demo.userRef) return;
    demo.adapter
      .readPosition(ref, demo.userRef)
      .then((p) => !stale && setPosition({ yes: p.yesShares ?? 0n, no: p.noShares ?? 0n }))
      .catch(() => !stale && setPosition({ yes: 0n, no: 0n }));
    return () => {
      stale = true;
    };
  }, [demo, ref, pending]);

  const submit = async () => {
    if (!demo?.adapter || !ref || !demo.userRef || !demo.signer) {
      setTone("neg");
      setMessage(t("eastboard.trade.real.connect"));
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const req = closes
        ? await demo.adapter.buildSell(ref, {
            outcome: side === 1 ? 0 : 1,
            deltaShares: shares * WAD,
            user: demo.userRef,
          })
        : await demo.adapter.buildTrade(ref, {
            side: "buy",
            outcome: side,
            deltaShares: shares * WAD,
            maxCostWad: shares * WAD,
            user: demo.userRef,
          } as never);
      await demo.adapter.submit(req, demo.signer as never);
      setTone("pos");
      setMessage(
        closes
          ? t("eastboard.trade.real.closed", {
              shares: String(shares),
              side: side === 1 ? "NO" : "YES",
            })
          : `${side === 1 ? "YES" : "NO"} +${String(shares)}`,
      );
    } catch (e) {
      setTone("neg");
      setMessage(e instanceof Error ? e.message.slice(0, 120) : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section>
        <div className="mt-1 flex items-baseline gap-4">
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
        {(position.yes > 0n || position.no > 0n) && (
          <div className="mt-4 border border-rule bg-inset p-3 font-mono text-[11px]">
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

      <section className="border border-rule bg-raised p-4">
        <div className="grid grid-cols-2 gap-1 border border-rule bg-inset p-1">
          <button
            type="button"
            onClick={() => setSide(1)}
            className={`px-2 py-2.5 font-mono text-[12px] font-bold uppercase tracking-[0.08em] transition-colors ${
              side === 1 ? "bg-pos text-canvas" : "text-muted hover:text-ink"
            }`}
          >
            YES {centsOf(yesPriceWad)}
          </button>
          <button
            type="button"
            onClick={() => setSide(0)}
            className={`px-2 py-2.5 font-mono text-[12px] font-bold uppercase tracking-[0.08em] transition-colors ${
              side === 0 ? "bg-neg text-canvas" : "text-muted hover:text-ink"
            }`}
          >
            NO {centsOf(WAD - yesPriceWad)}
          </button>
        </div>

        <div className="mt-3 flex gap-1">
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
            onChange={(e) =>
              setShares(BigInt(Math.max(1, Math.floor(Number(e.target.value) || 1))))
            }
            className="w-16 border border-rule bg-inset px-2 py-1.5 text-right font-mono text-xs text-ink outline-none focus:border-accent"
          />
        </div>

        <dl className="mt-3 space-y-1 border-t border-rule pt-3 font-mono text-[11px]">
          <div className="flex justify-between">
            <dt className="text-faint">
              {closes
                ? t("eastboard.trade.real.proceeds")
                : t("eastboard.trade.real.cost")}
            </dt>
            <dd className="text-ink">
              {quote === null
                ? "…"
                : `${(Number(quote) / 1e18).toFixed(2)} ${tokenSymbols.amm}`}
            </dd>
          </div>
          {!closes && (
            <div className="flex justify-between">
              <dt className="text-faint">
                {side === 1
                  ? t("eastboard.trade.real.paysIfYes")
                  : t("eastboard.trade.real.paysIfNo")}
              </dt>
              <dd className={side === 1 ? "text-pos" : "text-neg"}>
                {String(shares)} {tokenSymbols.amm}
              </dd>
            </div>
          )}
        </dl>

        <button
          type="button"
          onClick={() => void submit()}
          disabled={pending}
          className={`mt-3 w-full py-3 font-mono text-xs font-bold uppercase tracking-[0.1em] text-canvas transition-opacity disabled:opacity-40 ${
            side === 1 ? "bg-pos" : "bg-neg"
          }`}
        >
          {pending
            ? "…"
            : closes
              ? t("eastboard.trade.real.closeCta", {
                  shares: String(shares),
                  side: side === 1 ? "NO" : "YES",
                })
              : `${side === 1 ? "YES" : "NO"} · ${String(shares)}`}
        </button>

        {closes && (
          <p className="mt-2 font-mono text-[10px] text-warn">
            {t("eastboard.trade.real.cooldownShort")}
          </p>
        )}
        {message && (
          <p
            className={`mt-2 font-mono text-[11px] ${tone === "pos" ? "text-pos" : "text-neg"}`}
          >
            {message}
          </p>
        )}
      </section>
    </div>
  );
}
