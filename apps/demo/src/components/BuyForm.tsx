// `BuyForm` — outcome selector + share-delta input + slippage slider, calls
// `adapter.buildTrade` then `adapter.submit`. Surfaces success/error via
// react-hot-toast and via a `data-testid="buy-status"` element so the smoke
// test can poll on text without grepping toast portals.
//
// Slippage UX: the user picks a percent above the quoted cost. We pass
// `maxCostWad = quote.cost + (quote.cost * slippageBps / 10_000n)`. If the
// quote fails (e.g. AmmState missing) we display the error and keep the
// submit button disabled.
//
// The form requires `userRef` (the connected wallet pubkey) which is
// surfaced through `useDemo`. The buildTrade call requires the user pubkey
// at build time — see `buildTrade` in adapter.ts for why.

import { useCallback, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { WAD, type TradeQuote } from "@sooth/sdk-solana";
import { useDemo } from "../lib/DemoContext";
import { formatWad } from "../lib/utils";

export interface BuyFormProps {
  marketRef: string;
  // Called after a successful submit so the parent can refetch the snapshot.
  onSubmitted?: () => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "ready"; quote: TradeQuote }
  | { kind: "submitting" }
  | { kind: "success"; txId: string }
  | { kind: "error"; msg: string };

export function BuyForm({ marketRef, onSubmitted }: BuyFormProps) {
  const { adapter, userRef, signer, connected } = useDemo();
  const [outcome, setOutcome] = useState<0 | 1>(1);
  // `deltaShares` in WAD — but the user types whole shares. We multiply.
  const [shareInput, setShareInput] = useState("10");
  const [slippagePct, setSlippagePct] = useState(20);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const deltaShares = useMemo<bigint | null>(() => {
    const trimmed = shareInput.trim();
    if (!trimmed) return null;
    // Accept `1`, `1.5`, `10` etc. Multiply by WAD with up to 18 fractional
    // digits — anything beyond is truncated.
    const [whole, frac = ""] = trimmed.split(".");
    if (!/^[0-9]+$/.test(whole) || (frac && !/^[0-9]+$/.test(frac))) {
      return null;
    }
    const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
    const combined = BigInt(whole) * WAD + BigInt(fracPadded);
    if (combined <= 0n) return null;
    return combined;
  }, [shareInput]);

  const quote = useCallback(async () => {
    if (deltaShares === null) {
      setStatus({ kind: "error", msg: "Enter a positive share amount." });
      return;
    }
    setStatus({ kind: "quoting" });
    try {
      const q = await adapter.readQuote(marketRef, outcome, deltaShares);
      setStatus({ kind: "ready", quote: q });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "error", msg });
    }
  }, [adapter, marketRef, outcome, deltaShares]);

  const submit = useCallback(async () => {
    if (status.kind !== "ready") return;
    if (!userRef || !signer) {
      setStatus({ kind: "error", msg: "Connect a wallet first." });
      return;
    }
    if (deltaShares === null) return;
    setStatus({ kind: "submitting" });
    try {
      const slippageBps = BigInt(Math.max(0, Math.round(slippagePct * 100)));
      const maxCostWad =
        status.quote.cost + (status.quote.cost * slippageBps) / 10_000n;
      const req = await adapter.buildTrade(marketRef, {
        outcome,
        deltaShares,
        maxCostWad,
        side: "buy",
        // Solana adapter's documented meta channel — required at build time.
        // Cast away the type because this is by design not part of the
        // vendored TradeArgs.
        ...({ user: userRef } as Record<string, unknown>),
      } as never);
      const receipt = await adapter.submit(req, signer);
      setStatus({ kind: "success", txId: receipt.txId });
      toast.success(`Trade confirmed: ${receipt.txId.slice(0, 16)}…`);
      onSubmitted?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "error", msg });
      toast.error(`Trade failed: ${msg}`);
    }
  }, [
    adapter,
    marketRef,
    outcome,
    deltaShares,
    slippagePct,
    signer,
    userRef,
    status,
    onSubmitted,
  ]);

  return (
    <div
      className="border border-slate-700 bg-slate-900 p-4 rounded space-y-3"
      data-testid="buy-form"
    >
      <h3 className="text-xs uppercase tracking-widest text-slate-400">
        Buy outcome shares
      </h3>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setOutcome(1)}
          className={`flex-1 px-3 py-2 text-sm font-mono border rounded ${
            outcome === 1
              ? "bg-emerald-700 border-emerald-500 text-white"
              : "bg-slate-800 border-slate-700 text-slate-300"
          }`}
          data-testid="outcome-yes"
        >
          YES
        </button>
        <button
          type="button"
          onClick={() => setOutcome(0)}
          className={`flex-1 px-3 py-2 text-sm font-mono border rounded ${
            outcome === 0
              ? "bg-rose-700 border-rose-500 text-white"
              : "bg-slate-800 border-slate-700 text-slate-300"
          }`}
          data-testid="outcome-no"
        >
          NO
        </button>
      </div>

      <label className="block text-xs text-slate-400">
        Shares (WAD-scaled internally)
        <input
          type="text"
          inputMode="decimal"
          value={shareInput}
          onChange={(e) => setShareInput(e.target.value)}
          className="mt-1 w-full px-2 py-2 bg-slate-800 border border-slate-700 rounded font-mono text-sm"
          data-testid="share-input"
        />
      </label>

      <label className="block text-xs text-slate-400">
        Max slippage: {slippagePct}%
        <input
          type="range"
          min={0}
          max={50}
          step={1}
          value={slippagePct}
          onChange={(e) => setSlippagePct(Number(e.target.value))}
          className="mt-1 w-full"
          data-testid="slippage-slider"
        />
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void quote()}
          disabled={status.kind === "quoting" || status.kind === "submitting"}
          className="flex-1 px-3 py-2 text-sm font-mono bg-slate-800 border border-slate-600 rounded hover:bg-slate-700 disabled:opacity-50"
          data-testid="quote-button"
        >
          {status.kind === "quoting" ? "Quoting…" : "Get quote"}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={status.kind !== "ready" || !connected}
          className="flex-1 px-3 py-2 text-sm font-mono bg-emerald-600 border border-emerald-500 rounded hover:bg-emerald-500 disabled:opacity-50"
          data-testid="submit-button"
        >
          {status.kind === "submitting"
            ? "Submitting…"
            : connected
              ? "Submit trade"
              : "Connect wallet"}
        </button>
      </div>

      {status.kind === "ready" ? (
        <p
          className="text-xs font-mono text-slate-300"
          data-testid="quote-display"
        >
          Quote cost: {formatWad(status.quote.cost)} WAD
          {" · "}
          New YES px: {formatWad(status.quote.newYesPrice)}
        </p>
      ) : null}
      {status.kind === "success" ? (
        <p
          className="text-xs font-mono text-emerald-400"
          data-testid="buy-status"
        >
          Tx: {status.txId}
        </p>
      ) : null}
      {status.kind === "error" ? (
        <p className="text-xs font-mono text-rose-400" data-testid="buy-status">
          {status.msg}
        </p>
      ) : null}
    </div>
  );
}
