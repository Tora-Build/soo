// THE control: one bar per market.
//
// The left region is YES (green), the right is NO (red); the divider sits at
// the market price, so the bar is simultaneously the crowd split, the price
// display, and the bet control. Click a side to arm it — a compact strip
// unfolds with size presets and one confirm. Small enough that a feed can
// stack many of them; the market page uses the same control, because there
// is exactly one way to bet everywhere.
import { useState } from "react";

import { AMM_SYMBOL, BOOK_SYMBOL, WAD } from "../config";
import { cents, tokens } from "../lib/fmt";
import type { PulseMarket } from "../hooks/useMarkets";
import { useTrade } from "../hooks/useTrade";
import { useAdapter } from "../hooks/useAdapter";
import { ConnectButton } from "./ConnectButton";

const PRESETS = [10n, 50n, 100n];

function mult(priceWad: bigint): string {
  const p = Number(priceWad) / 1e18;
  return p <= 0.001 ? "—" : `${(1 / p).toFixed(2)}×`;
}

export function BetBar({ market }: { market: PulseMarket }) {
  const { signer } = useAdapter();
  const { trade, pending, error } = useTrade(market);
  const [armed, setArmed] = useState<"yes" | "no" | null>(null);
  const [amount, setAmount] = useState(10n);
  const [done, setDone] = useState<string | null>(null);

  const yesWad = market.yesPriceWad;
  const noWad = WAD - yesWad;
  const yesPct = Math.min(96, Math.max(4, (Number(yesWad) / 1e18) * 100));
  const symbol = market.isGraduated ? BOOK_SYMBOL : AMM_SYMBOL;

  if (market.isSettled) {
    return (
      <div className="flex h-10 items-center justify-center rounded-md border border-line bg-panel font-mono text-[11px] text-dim">
        settled ·{" "}
        <span className={market.winningOutcome === 1 ? "ml-1 text-yes" : "ml-1 text-no"}>
          {market.winningOutcome === 1 ? "YES" : market.winningOutcome === 0 ? "NO" : "INVALID"}
        </span>
      </div>
    );
  }

  const submit = async (side: "yes" | "no") => {
    setDone(null);
    await trade({ side, sizeWad: amount * WAD });
    setDone(`${side.toUpperCase()} · ${tokens(amount * WAD, 0)} shares placed`);
    setArmed(null);
  };

  return (
    <div>
      {/* the bar itself — two clickable halves, divider at the price */}
      <div className="flex h-10 overflow-hidden rounded-md border border-line">
        <button
          onClick={() => setArmed(armed === "yes" ? null : "yes")}
          style={{ width: `${yesPct}%` }}
          className={`flex items-center justify-between px-3 font-mono text-[11px] font-semibold transition-colors ${
            armed === "yes"
              ? "bg-yes text-bg"
              : "bg-yes-soft text-yes hover:bg-yes hover:text-bg"
          }`}
        >
          <span>YES</span>
          <span>
            {cents(yesWad)} · {mult(yesWad)}
          </span>
        </button>
        <button
          onClick={() => setArmed(armed === "no" ? null : "no")}
          style={{ width: `${100 - yesPct}%` }}
          className={`flex items-center justify-between px-3 font-mono text-[11px] font-semibold transition-colors ${
            armed === "no"
              ? "bg-no text-bg"
              : "bg-no-soft text-no hover:bg-no hover:text-bg"
          }`}
        >
          <span>
            {mult(noWad)} · {cents(noWad)}
          </span>
          <span>NO</span>
        </button>
      </div>

      {/* the armed strip — compact, inline, one confirm */}
      {armed && (
        <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1.5">
          {PRESETS.map((p) => (
            <button
              key={String(p)}
              onClick={() => setAmount(p)}
              className={`rounded px-2 py-1 font-mono text-[10px] ${
                amount === p ? "bg-inset text-ink ring-1 ring-line" : "text-dim hover:text-ink"
              }`}
            >
              {String(p)}
            </button>
          ))}
          <span className="font-mono text-[10px] text-faint">
            ~{tokens((amount * WAD * (armed === "yes" ? yesWad : noWad)) / WAD)} {symbol}
          </span>
          {signer ? (
            <button
              onClick={() => void submit(armed)}
              disabled={pending}
              className={`ml-auto rounded px-3 py-1.5 font-mono text-[10px] font-bold text-bg disabled:opacity-50 ${
                armed === "yes" ? "bg-yes" : "bg-no"
              }`}
            >
              {pending ? "…" : `BET ${armed.toUpperCase()} ${mult(armed === "yes" ? yesWad : noWad)}`}
            </button>
          ) : (
            <span className="ml-auto">
              <ConnectButton />
            </span>
          )}
        </div>
      )}
      {error && <p className="mt-1 font-mono text-[10px] text-no">{error.message.slice(0, 120)}</p>}
      {done && <p className="mt-1 font-mono text-[10px] text-yes">{done}</p>}
    </div>
  );
}
