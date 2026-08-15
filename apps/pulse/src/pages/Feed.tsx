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
        <span className="bg-pos-soft px-1.5 py-0.5 font-semibold text-pos">LIVE</span>
      ) : (
        <span className="text-accent">{Math.round(m.graduation * 100)}%→book</span>
      )}
      <span>{closes}</span>
    </span>
  );
}

function Row({ m }: { m: PulseMarket }) {
  return (
    <div className="border border-rule bg-raised p-3 transition-colors hover:border-accent/50">
      <div className="mb-2 flex items-baseline justify-between gap-3">
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
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-7">
      <div className="mb-3 flex items-baseline justify-between">
        <h1 className="east-label">markets · one axis, two sides</h1>
        <span className="font-mono text-[10px] text-faint">
          {markets.length} on-chain
        </span>
      </div>
      {isLoading && (
        <p className="py-16 text-center font-mono text-xs text-faint">
          reading the chain…
        </p>
      )}
      <div className="space-y-3">
        {open.map((m) => (
          <Row key={m.ref} m={m} />
        ))}
      </div>
      {settled.length > 0 && (
        <>
          <h2 className="east-label mt-8 mb-2">settled</h2>
          <div className="space-y-3">
            {settled.map((m) => (
              <Row key={m.ref} m={m} />
            ))}
          </div>
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
