// The feed: a clean list, one bar per market — bet without leaving the page.
// The question links to the full page (chart, book, tape); the bar bets.
import { Link } from "react-router-dom";
import { useEffect, useState } from "react";

import { BetBar } from "../components/BetBar";
import { useMarkets, type PulseMarket } from "../hooks/useMarkets";

function Meta({ m }: { m: PulseMarket }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const s = m.deadline - Math.floor(Date.now() / 1000);
  const closes =
    s <= 0
      ? "closed"
      : s > 86400
        ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
        : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-faint">
      {m.isGraduated ? (
        <span className="rounded bg-yes-soft px-1.5 py-0.5 font-semibold text-yes">LIVE</span>
      ) : (
        <span className="text-accent">{Math.round(m.graduation * 100)}%→book</span>
      )}
      <span>{closes}</span>
    </span>
  );
}

function Row({ m }: { m: PulseMarket }) {
  return (
    <div className="border-b border-line/60 py-3 last:border-b-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <Link
          to={`/m/${m.ref.replace(/^sol:/, "")}`}
          className="min-w-0 truncate text-sm font-medium text-ink hover:text-accent"
        >
          {m.question}
        </Link>
        <Meta m={m} />
      </div>
      <BetBar market={m} />
    </div>
  );
}

export function Feed() {
  const { markets, isLoading } = useMarkets();
  const open = markets.filter((m) => !m.isSettled);
  const settled = markets.filter((m) => m.isSettled);

  return (
    <div className="mx-auto max-w-2xl px-4 py-4">
      {isLoading && (
        <p className="py-16 text-center font-mono text-xs text-faint">
          reading the chain…
        </p>
      )}
      {open.map((m) => (
        <Row key={m.ref} m={m} />
      ))}
      {settled.length > 0 && (
        <>
          <h2 className="mt-6 mb-1 font-mono text-[10px] uppercase tracking-widest text-faint">
            settled
          </h2>
          {settled.map((m) => (
            <Row key={m.ref} m={m} />
          ))}
        </>
      )}
      {!isLoading && markets.length === 0 && (
        <p className="py-16 text-center font-mono text-xs text-faint">
          no markets on this cluster — launch one
        </p>
      )}
    </div>
  );
}
