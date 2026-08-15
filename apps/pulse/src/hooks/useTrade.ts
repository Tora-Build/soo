// One-tap trading, venue routed by the program's own flag.
//
// Back YES / Back NO is the entire vocabulary. Pre-graduation both route to
// the AMM (`trade_positions`, outcome 0|1 — the program takes NO natively).
// Post-graduation they route to the book as an aggressive limit at the touch
// (crossing whatever rests, posting nothing): a market order in the only
// sense a CLOB has one. Exits: `sellYes` uses the AMM's sell (with its
// cooldown) while bonding, and the complement-side book order when live.
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { WAD } from "../config";
import { useAdapter } from "./useAdapter";
import type { PulseMarket } from "./useMarkets";

export function useTrade(market: PulseMarket | null) {
  const { adapter, userRef, signer } = useAdapter();
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (args: {
      side: "yes" | "no";
      /** Shares, WAD. */
      sizeWad: bigint;
    }) => {
      if (!market || !userRef || !signer) {
        throw new Error("Connect a wallet first");
      }
      if (!market.isGraduated) {
        // AMM: outcome carries the side; the program prices both natively.
        const req = await adapter.buildTrade(market.ref, {
          side: "buy",
          outcome: args.side === "yes" ? 1 : 0,
          deltaShares: args.sizeWad,
          // Ceiling of 1.00/share — the definitional max. The program
          // reprices atomically; this only guards a race.
          maxCostWad: args.sizeWad,
          // Solana-only meta channel, same pattern as every other surface.
          user: userRef,
        } as never);
        return adapter.submit(req, signer);
      }
      // Book: buy YES = bid at the touch; buy NO = sell YES = ask side —
      // expressed as the program's one axis via side + tick.
      const book = await adapter.readBook(market.ref);
      // Buying YES lifts the best ask; buying NO (selling YES) hits the best
      // bid. Empty side → rest at mid.
      const touch =
        args.side === "yes"
          ? (book.asks[0]?.priceTick ?? 500)
          : (book.bids[0]?.priceTick ?? 500);
      const req = await adapter.buildBookPlace(market.ref, {
        user: userRef,
        side: args.side === "yes" ? 0 : 1,
        limitTick: touch,
        amount: args.sizeWad / 10n ** 12n, // WAD → base units
        matchLimit: 8,
        postRemainder: true,
      });
      return adapter.submit(req, signer);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pulse-market", market?.ref] });
      void qc.invalidateQueries({ queryKey: ["pulse-series", market?.ref] });
      void qc.invalidateQueries({ queryKey: ["pulse-markets"] });
    },
  });

  /** Client-side cost preview: LMSR delta, no RPC. */
  const previewCostWad = (side: "yes" | "no", sizeWad: bigint): bigint => {
    if (!market) return 0n;
    const b = Number(market.b) / 1e18;
    if (b <= 0) return 0n;
    const p = Number(market.yesPriceWad) / 1e18;
    const prob = side === "yes" ? p : 1 - p;
    const shares = Number(sizeWad) / 1e18;
    // First-order estimate: price drifts up as you buy; integrate the
    // logistic locally. Good enough for a preview the program re-prices.
    const drift = shares / (2 * b);
    const est = Math.min(0.999, prob * (1 - prob) * drift + prob) * shares;
    return BigInt(Math.round(est * 1e18));
  };

  return {
    trade: mutation.mutateAsync,
    pending: mutation.isPending,
    error: mutation.error as Error | null,
    previewCostWad,
    WAD,
  };
}
