// The market page, Polymarket's information model: the chance as the
// dominant element, the chart, the trade box, the tape.
import { useParams } from "react-router-dom";
import { useState } from "react";

import { PriceChart } from "../components/PriceChart";
import { TradeBox } from "../components/TradeBox";
import { GraduationBar } from "../components/GraduationBar";
import { useMarket } from "../hooks/useMarkets";
import { usePriceSeries } from "../hooks/usePriceSeries";
import { cents, pct, timeAgo } from "../lib/fmt";
import { WAD } from "../config";

export function Market() {
  const { pda } = useParams();
  const ref = pda ? `sol:${pda}` : undefined;
  const { market, isLoading } = useMarket(ref);
  const { points } = usePriceSeries(ref);
  const [showNo, setShowNo] = useState(false);

  if (isLoading || !market) {
    return (
      <p className="py-20 text-center font-mono text-xs text-faint">
        {isLoading ? "reading the chain…" : "no such market on this cluster"}
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-semibold leading-snug text-ink">
          {market.question}
        </h1>
        <div className="mt-2 flex items-baseline gap-3">
          <span className="font-mono text-4xl font-bold text-yes">
            {pct(market.yesPriceWad)}
          </span>
          <span className="font-mono text-sm text-dim">chance</span>
          <button
            onClick={() => setShowNo((v) => !v)}
            className={`ml-auto rounded px-2 py-1 font-mono text-[10px] uppercase ${showNo ? "bg-no-soft text-no" : "text-faint hover:text-dim"}`}
          >
            NO line
          </button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <PriceChart
            points={points}
            liveYesWad={market.yesPriceWad}
            showNo={showNo}
          />
          <GraduationBar
            progress={market.graduation}
            graduated={market.isGraduated}
          />
          <section className="rounded-md border border-line bg-panel">
            <h2 className="border-b border-line px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-dim">
              recent plays
            </h2>
            <ul className="max-h-64 overflow-y-auto">
              {[...points].reverse().slice(0, 30).map((p, i) => (
                <li
                  key={i}
                  className="flex justify-between border-b border-line/50 px-3 py-1.5 font-mono text-[11px]"
                >
                  <span className={p.yesPriceWad >= WAD / 2n ? "text-yes" : "text-no"}>
                    YES {cents(p.yesPriceWad)}
                  </span>
                  <span className="text-faint">
                    {p.venue} · {timeAgo(p.ts)} ago
                  </span>
                </li>
              ))}
              {points.length === 0 && (
                <li className="px-3 py-3 font-mono text-[11px] text-faint">
                  no trades yet — be the first
                </li>
              )}
            </ul>
          </section>
        </div>
        <TradeBox market={market} />
      </div>
    </div>
  );
}
