// `MarketList` — minimal landing page. Production would query an indexer
// for the live market set. The Solana fork has no indexer wired yet, so we
// either show the configured single market (when set) or print a "no
// markets configured" hint.

import { Link } from "react-router-dom";
import { useDemo } from "../lib/DemoContext";
import { truncatePubkey } from "../lib/utils";

export function MarketList() {
  const { marketRef } = useDemo();

  if (!marketRef) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-2 text-sm text-slate-400">
        <h1 className="text-lg text-slate-100">No markets configured</h1>
        <p>
          This demo points at a single market. Set{" "}
          <code className="font-mono">VITE_DEMO_MARKET_REF</code> in your
          environment, or visit{" "}
          <code className="font-mono">/m/&lt;marketPda&gt;</code> directly.
        </p>
        <p>
          The smoke test wires its own market via{" "}
          <code className="font-mono">DemoProvider override</code>; see{" "}
          <code className="font-mono">tests/happy-path.test.tsx</code>.
        </p>
      </div>
    );
  }

  const id = marketRef.replace(/^sol:/, "");

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-3">
      <h1 className="text-lg text-slate-100">Markets</h1>
      <ul className="space-y-2">
        <li>
          <Link
            to={`/m/${id}`}
            data-testid="market-link"
            className="block px-3 py-3 border border-slate-700 bg-slate-900 rounded hover:bg-slate-800 font-mono text-sm"
          >
            {truncatePubkey(id, 12, 12)}
          </Link>
        </li>
      </ul>
    </div>
  );
}
