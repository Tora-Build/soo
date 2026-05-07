// Mint / merge complete-set CTA. On Solana the upstream MintMergePanel
// sits inside the orderbook terminal (sooth_book gated on P1) so users
// have no path to mint/merge complete sets through the UI today. This
// surfaces both as a small portfolio-level panel:
//
//   mint:  N USDC → N·WAD YES + N·WAD NO  (debit USDC, credit outcome tokens)
//   merge: N·WAD YES + N·WAD NO → N USDC  (burn outcome tokens, redeem USDC)
//
// Submit goes via the chain-shim's writeContract dispatchers
// `mintCompleteSet` / `mergeCompleteSet`; see
// `apps/demo/src/lib/chain-shim/amm-bridge.ts::dispatchCompleteSet`.

import { useCallback, useState } from "react";
import { useAccount, useWriteContract } from "@/lib/chain-shim";
import toast from "react-hot-toast";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { demoConfig } from "../../../lib/config";

export function CompleteSetPanel() {
  const { isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [amount, setAmount] = useState("10");
  const [pending, setPending] = useState<"mint" | "merge" | null>(null);

  const marketRef = demoConfig.marketRef;

  const handle = useCallback(
    async (kind: "mint" | "merge") => {
      if (!marketRef) {
        toast.error("No demo market configured");
        return;
      }
      const parsed = Number(amount);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        toast.error("Enter a positive USDC amount");
        return;
      }
      // Convert to USDC base units (6 decimals). For merge this is also the
      // count of YES + NO shares burned (1 USDC = 1·WAD YES = 1·WAD NO).
      const baseUnits = BigInt(Math.round(parsed * 1_000_000));
      const tid = toast.loading(
        kind === "mint"
          ? `Minting ${parsed} USDC → ${parsed} YES + ${parsed} NO…`
          : `Merging ${parsed} YES + ${parsed} NO → ${parsed} USDC…`,
      );
      setPending(kind);
      try {
        await writeContractAsync({
          functionName:
            kind === "mint" ? "mintCompleteSet" : "mergeCompleteSet",
          args: [marketRef, baseUnits],
        });
        toast.success(
          kind === "mint" ? "Complete set minted" : "Complete set merged",
          { id: tid },
        );
      } catch (e) {
        toast.error((e as Error).message?.slice(0, 80) ?? "Failed", {
          id: tid,
        });
      } finally {
        setPending(null);
      }
    },
    [amount, marketRef, writeContractAsync],
  );

  if (!isConnected) return null;

  return (
    <Card className="bg-raised border border-rule p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-ink">Complete Set</h3>
        <span className="text-xs font-mono text-muted uppercase tracking-[0.12em]">
          {marketRef ? marketRef.slice(0, 12) + "…" : "no market"}
        </span>
      </div>
      <p className="text-xs text-muted mb-4">
        Mint creates equal-weight YES + NO from USDC at parity. Merge does the
        reverse — collapse a balanced YES+NO position back to USDC. No price
        impact, no slippage.
      </p>
      <div className="flex gap-3 items-end">
        <label className="flex-1">
          <span className="block text-[10px] font-mono uppercase tracking-[0.12em] text-muted mb-1">
            USDC amount
          </span>
          <input
            type="number"
            min={0}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-inset border border-rule px-3 py-2 text-sm font-mono text-ink"
          />
        </label>
        <Button
          className="btn btn-primary"
          onClick={() => handle("mint")}
          disabled={pending !== null}
          isLoading={pending === "mint"}
        >
          MINT
        </Button>
        <Button
          className="btn btn-secondary"
          onClick={() => handle("merge")}
          disabled={pending !== null}
          isLoading={pending === "merge"}
        >
          MERGE
        </Button>
      </div>
    </Card>
  );
}
