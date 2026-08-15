// The market page, prdt-classic shaped: question + countdown as the round
// header, the dual-line chart, left/right YES-NO bet panels, the tape — and
// the order book only when asked for.
import { useParams } from "react-router-dom";
import { useEffect, useState } from "react";

import { PriceChart } from "../components/PriceChart";
import { BetBar } from "../components/BetBar";
import { GraduationBar } from "../components/GraduationBar";
import { OrderBookPanel } from "../components/OrderBookPanel";
import { useMarket } from "../hooks/useMarkets";
import { usePriceSeries } from "../hooks/usePriceSeries";
import { cents, pct, timeAgo } from "../lib/fmt";
import { WAD } from "../config";

function Countdown({ deadline }: { deadline: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const s = deadline - Math.floor(Date.now() / 1000);
  if (s <= 0) return <span className="text-warn">closed</span>;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (
    <span className="tabular-nums">
      {d > 0 ? `${d}d ` : ""}
      {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:
      {String(ss).padStart(2, "0")}
    </span>
  );
}

export function Market() {
  const { pda } = useParams();
  const ref = pda ? `sol:${pda}` : undefined;
  const { market, isLoading } = useMarket(ref);
  const { points } = usePriceSeries(ref);

  if (isLoading || !market) {
    return (
      <p className="py-20 text-center font-mono text-xs text-faint">
        {isLoading ? "reading the chain…" : "no such market on this cluster"}
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      {/* the round header: question, chance, lock timer */}
      <header className="mb-4 rounded-md border border-line bg-panel p-4">
        <h1 className="text-lg font-semibold leading-snug text-ink">
          {market.question}
        </h1>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono">
          <span className="text-3xl font-bold text-yes">{pct(market.yesPriceWad)}</span>
          <span className="text-sm text-dim">chance</span>
          <span className="ml-auto text-sm text-dim">
            market locks in{" "}
            <span className="text-ink">
              <Countdown deadline={market.deadline} />
            </span>
          </span>
          <span className="text-[11px] text-faint">{points.length} plays</span>
        </div>
      </header>

      <div className="space-y-4">
        {/* the same one-bar control the feed uses — one way to bet, everywhere */}
        <BetBar market={market} />
        <div className="space-y-4">
          <PriceChart points={points} liveYesWad={market.yesPriceWad} />
          <GraduationBar progress={market.graduation} graduated={market.isGraduated} />
          <OrderBookPanel market={market} />
          <section className="rounded-md border border-line bg-panel">
            <h2 className="border-b border-line px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-dim">
              recent plays
            </h2>
            <ul className="max-h-56 overflow-y-auto">
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
                  no plays yet — be the first
                </li>
              )}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
