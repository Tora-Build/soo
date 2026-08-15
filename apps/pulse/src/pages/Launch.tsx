// Launch a market in ten seconds: question, deadline, one of three sizes.
// One signature — create_market composes the whole init.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";

import { AMM_SYMBOL, WAD } from "../config";
import { useAdapter } from "../hooks/useAdapter";
import { rememberCreatedMarket } from "../hooks/useMarkets";
import { ConnectButton } from "../components/ConnectButton";

const SIZES = [
  { label: "Small", b: 100n, cost: "69" },
  { label: "Medium", b: 1000n, cost: "693" },
  { label: "Large", b: 10000n, cost: "6,930" },
];

export function Launch() {
  const { adapter, userRef, signer } = useAdapter();
  const navigate = useNavigate();
  const [question, setQuestion] = useState("");
  const [days, setDays] = useState(7);
  const [size, setSize] = useState(SIZES[0]);

  const launch = useMutation({
    mutationFn: async () => {
      const req = await adapter.buildCreateMarket({
        question: question.trim(),
        user: userRef!,
        adjudicator: userRef!,
        deadline: BigInt(Math.floor(Date.now() / 1000) + days * 86_400),
        initialB: size.b * WAD,
      } as never);
      await adapter.submit(req, signer!);
      const pda = (req.meta as { marketPda?: string }).marketPda;
      if (pda) rememberCreatedMarket(`sol:${pda}`, question.trim());
      return pda;
    },
    onSuccess: (pda) => {
      if (pda) navigate(`/m/${pda}`);
    },
  });

  return (
    <div className="mx-auto max-w-xl px-4 py-6 md:px-7">
      <h1 className="east-label mb-4 text-[11px]">
        launch a market
      </h1>
      <label className="block font-mono text-[11px] text-faint">
        the question (stored on-chain, verified against its hash)
      </label>
      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        maxLength={300}
        rows={3}
        placeholder="Will …?"
        className="mt-1 w-full border border-rule bg-inset p-3 text-sm text-ink outline-none focus:border-accent"
      />
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <label className="font-mono text-[11px] text-faint">closes in</label>
          <div className="mt-1 flex gap-2">
            {[1, 7, 30].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`flex-1 px-2 py-2 font-mono text-xs ${days === d ? "bg-inset text-ink ring-1 ring-rule" : "text-muted"}`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="font-mono text-[11px] text-faint">
            liquidity · your max loss
          </label>
          <div className="mt-1 flex gap-2">
            {SIZES.map((s) => (
              <button
                key={s.label}
                onClick={() => setSize(s)}
                title={`${s.cost} ${AMM_SYMBOL} max loss`}
                className={`flex-1 px-2 py-2 font-mono text-xs ${size === s ? "bg-inset text-ink ring-1 ring-rule" : "text-muted"}`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <p className="mt-1 font-mono text-[10px] text-faint">
            max loss {size.cost} {AMM_SYMBOL} (b·ln2)
          </p>
        </div>
      </div>
      {signer ? (
        <button
          onClick={() => void launch.mutateAsync()}
          disabled={launch.isPending || question.trim().length < 8}
          className="mt-5 w-full bg-accent py-3 font-semibold text-canvas disabled:opacity-40"
        >
          {launch.isPending ? "Launching…" : "Launch market"}
        </button>
      ) : (
        <div className="mt-5">
          <ConnectButton full />
        </div>
      )}
      {launch.error && (
        <p className="mt-2 font-mono text-[11px] text-neg">
          {(launch.error as Error).message.slice(0, 160)}
        </p>
      )}
    </div>
  );
}
