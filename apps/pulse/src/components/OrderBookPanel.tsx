// The order book, behind a click — the design decision the user called out
// on prdt: simple front, depth only for those who ask. Renders live depth
// and the user's resting orders with cancel; a compact limit form for
// graduated markets. Collapsed by default, its own visual room when open.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { BOOK_SYMBOL } from "../config";
import type { PulseMarket } from "../hooks/useMarkets";
import { useAdapter } from "../hooks/useAdapter";

export function OrderBookPanel({ market }: { market: PulseMarket }) {
  const { adapter, userRef, signer } = useAdapter();
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<0 | 1>(0);
  const [tick, setTick] = useState(500);
  const [size, setSize] = useState(10);
  const qc = useQueryClient();

  const book = useQuery({
    queryKey: ["pulse-book", market.ref],
    enabled: open && market.isGraduated,
    refetchInterval: 6_000,
    queryFn: () => adapter.readBook(market.ref),
  });

  const place = useMutation({
    mutationFn: async () => {
      const req = await adapter.buildBookPlace(market.ref, {
        user: userRef!,
        side,
        limitTick: tick,
        amount: BigInt(size) * 10n ** 6n,
        matchLimit: 8,
        postRemainder: true,
      });
      return adapter.submit(req, signer!);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["pulse-book"] }),
  });

  const cancel = useMutation({
    mutationFn: async (seq: bigint) => {
      const req = await adapter.buildBookCancelMany(market.ref, {
        user: userRef!,
        orderSeqs: [seq],
      });
      return adapter.submit(req, signer!);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["pulse-book"] }),
  });

  if (!market.isGraduated) return null;

  return (
    <section className="rounded-md border border-line bg-panel">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-dim hover:text-ink"
      >
        <span>advanced · order book</span>
        <span>{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="border-t border-line p-3">
          <div className="grid grid-cols-2 gap-4 font-mono text-[11px]">
            <div>
              <div className="mb-1 text-yes">bids</div>
              {(book.data?.bids ?? []).slice(0, 8).map((o) => (
                <div key={String(o.seq)} className="flex justify-between">
                  <span className="text-yes">{(o.priceTick / 10).toFixed(1)}¢</span>
                  <span className="text-dim">{(Number(o.amount) / 1e6).toFixed(0)}</span>
                  {userRef && o.trader === userRef.replace(/^sol:/, "") && (
                    <button
                      onClick={() => void cancel.mutateAsync(o.seq)}
                      className="text-faint hover:text-no"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {book.data && book.data.bids.length === 0 && (
                <div className="text-faint">empty</div>
              )}
            </div>
            <div>
              <div className="mb-1 text-right text-no">asks</div>
              {(book.data?.asks ?? []).slice(0, 8).map((o) => (
                <div key={String(o.seq)} className="flex justify-between">
                  {userRef && o.trader === userRef.replace(/^sol:/, "") && (
                    <button
                      onClick={() => void cancel.mutateAsync(o.seq)}
                      className="text-faint hover:text-no"
                    >
                      ✕
                    </button>
                  )}
                  <span className="text-dim">{(Number(o.amount) / 1e6).toFixed(0)}</span>
                  <span className="text-no">{(o.priceTick / 10).toFixed(1)}¢</span>
                </div>
              ))}
              {book.data && book.data.asks.length === 0 && (
                <div className="text-right text-faint">empty</div>
              )}
            </div>
          </div>

          {signer && (
            <div className="mt-3 flex items-center gap-2 border-t border-line pt-3 font-mono text-[11px]">
              <select
                value={side}
                onChange={(e) => setSide(Number(e.target.value) as 0 | 1)}
                className="rounded border border-line bg-inset px-2 py-1 text-ink"
              >
                <option value={0}>bid</option>
                <option value={1}>ask</option>
              </select>
              <input
                type="number"
                min={1}
                max={999}
                value={tick}
                onChange={(e) => setTick(Number(e.target.value))}
                className="w-20 rounded border border-line bg-inset px-2 py-1 text-ink"
              />
              <span className="text-faint">ticks</span>
              <input
                type="number"
                min={1}
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
                className="w-20 rounded border border-line bg-inset px-2 py-1 text-ink"
              />
              <span className="text-faint">{BOOK_SYMBOL}</span>
              <button
                onClick={() => void place.mutateAsync()}
                disabled={place.isPending}
                className="ml-auto rounded bg-inset px-3 py-1.5 text-ink ring-1 ring-line hover:ring-accent disabled:opacity-50"
              >
                {place.isPending ? "…" : "place limit"}
              </button>
            </div>
          )}
          {(place.error || cancel.error) && (
            <p className="mt-2 text-[10px] text-no">
              {String((place.error ?? cancel.error) as Error).slice(0, 120)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
