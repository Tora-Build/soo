// The feed: pump.fun's discovery model over prediction markets. KOTH slot for
// the market closest to graduation, cards beneath, each card one tap from a
// real trade.
import { Link } from "react-router-dom";

import { cents, timeAgo } from "../lib/fmt";
import { GraduationBar } from "../components/GraduationBar";
import { useMarkets, type PulseMarket } from "../hooks/useMarkets";
import { WAD } from "../config";

function Card({ m, king }: { m: PulseMarket; king?: boolean }) {
  return (
    <Link
      to={`/m/${m.ref.replace(/^sol:/, "")}`}
      className={`block rounded-md border bg-panel p-4 transition-colors hover:border-accent ${
        king ? "border-warn" : "border-line"
      }`}
    >
      {king && (
        <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-warn">
          ♛ closest to graduation
        </div>
      )}
      <h3 className="min-h-[2.5rem] text-sm font-medium leading-snug text-ink">
        {m.question}
      </h3>
      <div className="mt-3 flex items-end justify-between">
        <div>
          <div className="font-mono text-2xl font-bold text-yes">
            {cents(m.yesPriceWad)}
          </div>
          <div className="font-mono text-[10px] uppercase text-faint">yes</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-lg text-no">{cents(WAD - m.yesPriceWad)}</div>
          <div className="font-mono text-[10px] uppercase text-faint">no</div>
        </div>
      </div>
      <div className="mt-3">
        <GraduationBar progress={m.graduation} graduated={m.isGraduated} />
      </div>
      <div className="mt-2 font-mono text-[10px] text-faint">
        {m.isSettled
          ? "settled"
          : m.deadline
            ? `closes in ${timeAgo(2 * Math.floor(Date.now() / 1000) - m.deadline)}`
            : ""}
      </div>
    </Link>
  );
}

export function Feed() {
  const { markets, isLoading } = useMarkets();
  const open = markets.filter((m) => !m.isSettled);
  const king = [...open]
    .filter((m) => !m.isGraduated)
    .sort((a, b) => b.graduation - a.graduation)[0];
  const rest = open.filter((m) => m !== king);
  const settled = markets.filter((m) => m.isSettled);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      {isLoading && (
        <p className="py-16 text-center font-mono text-xs text-faint">
          reading the chain…
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {king && <Card m={king} king />}
        {rest.map((m) => (
          <Card key={m.ref} m={m} />
        ))}
        {settled.map((m) => (
          <Card key={m.ref} m={m} />
        ))}
      </div>
      {!isLoading && markets.length === 0 && (
        <p className="py-16 text-center font-mono text-xs text-faint">
          no markets on this cluster — launch one
        </p>
      )}
    </div>
  );
}
