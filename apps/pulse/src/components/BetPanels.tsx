// The prdt.finance classic layout, mapped onto a binary market:
//
//   prdt                     pulse
//   ────────────────────     ─────────────────────────────
//   UP card (left, green)    YES panel — payout 1/p ×
//   DOWN card (right, red)   NO panel — payout 1/(1−p) ×
//   crowd split 56/44        the PRICE is the crowd split
//   round locks in 5:00      market closes in <deadline>
//   tap side → confirm       tap side → amount → one tap
//
// prdt's rounds are 5-minute pools; ours are markets with deadlines — the
// design carries over, the mechanic stays LMSR/book. Payout shown is the
// definitional 1/price (each share pays 1.00 if right), before fees.
import { useState } from "react";

import { AMM_SYMBOL, BOOK_SYMBOL, WAD } from "../config";
import { cents, tokens } from "../lib/fmt";
import type { PulseMarket } from "../hooks/useMarkets";
import { useTrade } from "../hooks/useTrade";
import { useAdapter } from "../hooks/useAdapter";
import { ConnectButton } from "./ConnectButton";

const PRESETS = [10n, 50n, 100n];

function multiplier(priceWad: bigint): string {
  const p = Number(priceWad) / 1e18;
  if (p <= 0.001) return "—";
  return `${(1 / p).toFixed(2)}×`;
}

export function BetPanels({ market }: { market: PulseMarket }) {
  const { signer } = useAdapter();
  const { trade, pending, error } = useTrade(market);
  const [armed, setArmed] = useState<"yes" | "no" | null>(null);
  const [amount, setAmount] = useState(10n);
  const [done, setDone] = useState<string | null>(null);

  const symbol = market.isGraduated ? BOOK_SYMBOL : AMM_SYMBOL;
  const yesWad = market.yesPriceWad;
  const noWad = WAD - yesWad;
  const yesPct = Math.round((Number(yesWad) / 1e18) * 100);

  const submit = async (side: "yes" | "no") => {
    setDone(null);
    await trade({ side, sizeWad: amount * WAD });
    setDone(`${side.toUpperCase()} bet placed — ${tokens(amount * WAD, 0)} shares`);
    setArmed(null);
  };

  if (market.isSettled) {
    return (
      <div className="rounded-md border border-line bg-panel p-4 text-center font-mono text-sm text-dim">
        Settled ·{" "}
        <span className={market.winningOutcome === 1 ? "text-yes" : "text-no"}>
          {market.winningOutcome === 1 ? "YES" : market.winningOutcome === 0 ? "NO" : "INVALID"}
        </span>{" "}
        — claims live in your portfolio
      </div>
    );
  }

  return (
    <div>
      {/* the crowd bar — prdt's split, which for us IS the price */}
      <div className="mb-3">
        <div className="flex justify-between font-mono text-[11px]">
          <span className="text-yes">{yesPct}% YES</span>
          <span className="text-no">{100 - yesPct}% NO</span>
        </div>
        <div className="mt-1 flex h-1.5 overflow-hidden rounded">
          <div className="bg-yes" style={{ width: `${yesPct}%` }} />
          <div className="bg-no" style={{ width: `${100 - yesPct}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* YES — left, green */}
        <button
          onClick={() => setArmed(armed === "yes" ? null : "yes")}
          className={`rounded-lg border p-4 text-left transition-all ${
            armed === "yes"
              ? "border-yes bg-yes-soft"
              : "border-line bg-panel hover:border-yes/60"
          }`}
        >
          <div className="font-mono text-[10px] uppercase tracking-widest text-yes">
            ▲ yes
          </div>
          <div className="mt-1 font-mono text-2xl font-bold text-yes">
            {multiplier(yesWad)}
          </div>
          <div className="font-mono text-[11px] text-dim">
            payout · {cents(yesWad)} a share
          </div>
        </button>
        {/* NO — right, red */}
        <button
          onClick={() => setArmed(armed === "no" ? null : "no")}
          className={`rounded-lg border p-4 text-right transition-all ${
            armed === "no"
              ? "border-no bg-no-soft"
              : "border-line bg-panel hover:border-no/60"
          }`}
        >
          <div className="font-mono text-[10px] uppercase tracking-widest text-no">
            no ▼
          </div>
          <div className="mt-1 font-mono text-2xl font-bold text-no">
            {multiplier(noWad)}
          </div>
          <div className="font-mono text-[11px] text-dim">
            payout · {cents(noWad)} a share
          </div>
        </button>
      </div>

      {/* tap a side → the amount row arms under it, prdt-style */}
      {armed && (
        <div className="mt-3 rounded-lg border border-line bg-panel p-3">
          <div className="flex gap-2">
            {PRESETS.map((p) => (
              <button
                key={String(p)}
                onClick={() => setAmount(p)}
                className={`flex-1 rounded px-2 py-2 font-mono text-xs ${
                  amount === p
                    ? "bg-inset text-ink ring-1 ring-line"
                    : "text-dim hover:text-ink"
                }`}
              >
                {String(p)}
              </button>
            ))}
            <span className="self-center font-mono text-[10px] text-faint">
              shares
            </span>
          </div>
          <div className="mt-2 flex justify-between font-mono text-[11px] text-dim">
            <span>
              costs ~{tokens((amount * WAD * (armed === "yes" ? yesWad : noWad)) / WAD)}{" "}
              {symbol}
            </span>
            <span className={armed === "yes" ? "text-yes" : "text-no"}>
              wins {tokens(amount * WAD, 0)} {symbol}
            </span>
          </div>
          {signer ? (
            <button
              onClick={() => void submit(armed)}
              disabled={pending}
              className={`mt-2 w-full rounded py-3 font-semibold text-bg disabled:opacity-50 ${
                armed === "yes" ? "bg-yes" : "bg-no"
              }`}
            >
              {pending
                ? "Placing…"
                : `Bet ${armed.toUpperCase()} · ${multiplier(armed === "yes" ? yesWad : noWad)}`}
            </button>
          ) : (
            <div className="mt-2">
              <ConnectButton full />
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="mt-2 font-mono text-[11px] text-no">{error.message.slice(0, 140)}</p>
      )}
      {done && <p className="mt-2 font-mono text-[11px] text-yes">{done}</p>}
    </div>
  );
}
