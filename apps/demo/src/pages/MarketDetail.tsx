// `MarketDetail` — the buy-flow happy-path page. Reads the snapshot, renders
// the buy form + position display side-by-side. Calls `refetch` after every
// successful submit.

import { useParams } from "react-router-dom";
import { useDemo } from "../lib/DemoContext";
import { useSnapshot } from "../hooks/useSnapshot";
import { BuyForm } from "../components/BuyForm";
import { PositionDisplay } from "../components/PositionDisplay";
import { formatWad, truncatePubkey } from "../lib/utils";

export function MarketDetail() {
  const { marketRef: ctxRef, userRef } = useDemo();
  const params = useParams<{ marketId?: string }>();
  // Route param wins over the demo-context default; that lets a deployed
  // version link to per-market pages even though the demo itself only has
  // one market.
  const marketRef = params.marketId
    ? `sol:${params.marketId}`
    : (ctxRef ?? null);

  const { data, error, loading, refetch } = useSnapshot(marketRef, userRef);

  if (!marketRef) {
    return (
      <div className="p-6 text-sm text-slate-400">
        No market configured. Set <code>VITE_DEMO_MARKET_REF</code> or visit{" "}
        <code>/m/&lt;marketPda&gt;</code>.
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6 text-sm text-rose-400" data-testid="market-error">
        Failed to read market: {error.message}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-6 text-sm text-slate-400" data-testid="market-loading">
        Loading market…
      </div>
    );
  }

  const m = data.market;

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      <header>
        <p className="text-xs uppercase tracking-widest text-slate-400">
          Market
        </p>
        <h1
          className="font-mono text-lg break-all"
          data-testid="market-heading"
        >
          {truncatePubkey(marketRef.replace(/^sol:/, ""), 8, 8)}
        </h1>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
          <dt className="text-slate-400">qYes</dt>
          <dd data-testid="market-qyes">{formatWad(m.qYes)}</dd>
          <dt className="text-slate-400">qNo</dt>
          <dd data-testid="market-qno">{formatWad(m.qNo)}</dd>
          <dt className="text-slate-400">b (liquidity)</dt>
          <dd>{formatWad(m.b)}</dd>
          <dt className="text-slate-400">isLive</dt>
          <dd>{String(m.isLive)}</dd>
        </dl>
      </header>

      <PositionDisplay position={data.position} loading={loading} />
      <BuyForm marketRef={marketRef} onSubmitted={() => void refetch()} />
    </div>
  );
}
