// Back YES / Back NO — the entire trade surface. Amount presets, live cost
// preview (client-side LMSR, zero RPC), payout-if-right, one signature.
import { useState } from "react";

import { AMM_SYMBOL, BOOK_SYMBOL, WAD } from "../config";
import { cents, tokens } from "../lib/fmt";
import type { PulseMarket } from "../hooks/useMarkets";
import { useTrade } from "../hooks/useTrade";
import { useAdapter } from "../hooks/useAdapter";
import { ConnectButton } from "./ConnectButton";

const PRESETS = [10n, 50n, 100n];

export function TradeBox({ market }: { market: PulseMarket }) {
  const { signer } = useAdapter();
  const { trade, pending, error, previewCostWad } = useTrade(market);
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [amount, setAmount] = useState(10n);
  const [done, setDone] = useState<string | null>(null);

  const symbol = market.isGraduated ? BOOK_SYMBOL : AMM_SYMBOL;
  const sizeWad = amount * WAD;
  const costWad = previewCostWad(side, sizeWad);
  const priceWad =
    side === "yes" ? market.yesPriceWad : WAD - market.yesPriceWad;

  const submit = async () => {
    setDone(null);
    await trade({ side, sizeWad });
    setDone(
      `Backed ${side.toUpperCase()} — ${tokens(sizeWad, 0)} shares, one signature.`,
    );
  };

  if (market.isSettled) {
    return (
      <div className="rounded-md border border-line bg-panel p-4 text-sm text-dim">
        Settled — {market.winningOutcome === 1 ? "YES" : market.winningOutcome === 0 ? "NO" : "INVALID"}.
        Claims live in your portfolio.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-line bg-panel p-4">
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setSide("yes")}
          className={`rounded px-3 py-3 text-center font-semibold transition-colors ${
            side === "yes"
              ? "bg-yes-soft text-yes ring-1 ring-yes"
              : "bg-inset text-dim hover:text-ink"
          }`}
        >
          Back YES
          <div className="font-mono text-xs opacity-80">{cents(market.yesPriceWad)}</div>
        </button>
        <button
          onClick={() => setSide("no")}
          className={`rounded px-3 py-3 text-center font-semibold transition-colors ${
            side === "no"
              ? "bg-no-soft text-no ring-1 ring-no"
              : "bg-inset text-dim hover:text-ink"
          }`}
        >
          Back NO
          <div className="font-mono text-xs opacity-80">{cents(WAD - market.yesPriceWad)}</div>
        </button>
      </div>

      <div className="mt-3 flex gap-2">
        {PRESETS.map((p) => (
          <button
            key={String(p)}
            onClick={() => setAmount(p)}
            className={`flex-1 rounded px-2 py-2 font-mono text-xs ${
              amount === p ? "bg-inset text-ink ring-1 ring-line" : "text-dim hover:text-ink"
            }`}
          >
            {String(p)} sh
          </button>
        ))}
      </div>

      <dl className="mt-3 space-y-1 border-t border-line pt-3 font-mono text-xs">
        <div className="flex justify-between">
          <dt className="text-faint">Price</dt>
          <dd className="text-ink">{cents(priceWad)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-faint">Est. cost</dt>
          <dd className="text-ink">
            ~{tokens(costWad)} {symbol}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-faint">Pays if right</dt>
          <dd className={side === "yes" ? "text-yes" : "text-no"}>
            {tokens(sizeWad, 0)} {symbol}
          </dd>
        </div>
      </dl>

      {signer ? (
        <button
          onClick={() => void submit()}
          disabled={pending}
          className={`mt-3 w-full rounded py-3 font-semibold text-bg transition-opacity disabled:opacity-50 ${
            side === "yes" ? "bg-yes" : "bg-no"
          }`}
        >
          {pending ? "Signing…" : `Back ${side.toUpperCase()} · ${tokens(sizeWad, 0)} shares`}
        </button>
      ) : (
        <div className="mt-3">
          <ConnectButton full />
        </div>
      )}

      {error && (
        <p className="mt-2 font-mono text-[11px] text-no">{error.message.slice(0, 140)}</p>
      )}
      {done && <p className="mt-2 font-mono text-[11px] text-yes">{done}</p>}
      <p className="mt-3 border-t border-line pt-2 font-mono text-[10px] text-faint">
        {market.isGraduated
          ? `Order book venue · ${BOOK_SYMBOL} · crossing the touch`
          : `Bonding curve venue · ${AMM_SYMBOL} · one transaction, no approvals`}
      </p>
    </div>
  );
}
