// Operator-only actions for the demo market: request_lock + attest_outcome.
//
// Visibility: this panel auto-hides for non-adjudicators. We poll the
// per-market `Adjudicator` PDA, compare `authority` to the connected
// wallet's pubkey, and only render when they match. Existing wallets
// auto-allowlisted via useAutoRegisterAdjudicator only become adjudicators
// for NEW markets they create — for the seeded demo market the registered
// adjudicator is the creator keypair (`apps/demo/.localnet/creator-keypair.json`).
//
// Flow:
//   request_lock   — Open → Locked. Required precondition for attest.
//   attest_outcome — Locked → Settled (sets winning_outcome). Idempotent
//                    in terminal state.
//
// Localnet caveat: sooth_market::lock_for_resolution sets
// `Market.locked_at = now`; settle's gate is `now >= locked_at +
// LOCK_DURATION_SECS` (24h). solana-test-validator has no setClock, so
// even with a successful request_lock the attest_outcome won't pass the
// time guard until 24h have actually elapsed. The buttons themselves
// always work at the wire level; the on-chain guard is the only blocker.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useWriteContract } from "@/lib/chain-shim";
import toast from "react-hot-toast";
import { useDemo } from "../../../lib/DemoContext";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { demoConfig } from "../../../lib/config";

interface AdjudicatorState {
  market: string;
  authority: string;
  attestedOutcome: number | null;
  disputed: boolean;
}

const REFRESH_MS = 10_000;

export function OperatorActionsPanel() {
  const { isConnected, address } = useAccount();
  const demo = useDemo();
  const adapter = demo?.adapter ?? null;
  const { writeContractAsync } = useWriteContract();
  const [adjudicator, setAdjudicator] = useState<AdjudicatorState | null>(null);
  const [pending, setPending] = useState<
    "lock" | "attestYes" | "attestNo" | "attestInvalid" | "settle" | null
  >(null);

  const marketRef = demoConfig.marketRef;
  const userBase58 = useMemo(
    () => (address ? String(address).replace(/^0x/, "") : null),
    [address],
  );

  const refresh = useCallback(async () => {
    if (!adapter || !marketRef) return;
    try {
      const adj = await adapter.readAdjudicator(marketRef);
      setAdjudicator(adj);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[OperatorActionsPanel] readAdjudicator failed", e);
      setAdjudicator(null);
    }
  }, [adapter, marketRef]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const isAuthority =
    !!adjudicator && !!userBase58 && adjudicator.authority === userBase58;

  const lock = useCallback(async () => {
    if (!marketRef) return;
    const tid = toast.loading("Requesting lock — Market: Open → Locked…");
    setPending("lock");
    try {
      await writeContractAsync({
        functionName: "requestLock",
        args: [marketRef],
      });
      toast.success("Market locked", { id: tid });
      void refresh();
    } catch (e) {
      toast.error((e as Error).message?.slice(0, 100) ?? "Lock failed", {
        id: tid,
      });
    } finally {
      setPending(null);
    }
  }, [marketRef, writeContractAsync, refresh]);

  const attest = useCallback(
    async (
      outcome: 0 | 1 | 2,
      busyKind: "attestYes" | "attestNo" | "attestInvalid",
    ) => {
      if (!marketRef) return;
      const label = outcome === 0 ? "NO" : outcome === 1 ? "YES" : "INVALID";
      const tid = toast.loading(`Attesting outcome=${label} → Settled…`);
      setPending(busyKind);
      try {
        await writeContractAsync({
          functionName: "attestOutcome",
          args: [marketRef, outcome],
        });
        toast.success(`Settled with outcome=${label}`, { id: tid });
        void refresh();
      } catch (e) {
        toast.error(
          (e as Error).message?.slice(0, 100) ?? `Attest ${label} failed`,
          { id: tid },
        );
      } finally {
        setPending(null);
      }
    },
    [marketRef, writeContractAsync, refresh],
  );

  const settleMarket = useCallback(async () => {
    if (!marketRef) return;
    const tid = toast.loading("Settling — Locked → Settled…");
    setPending("settle");
    try {
      await writeContractAsync({ functionName: "settle", args: [marketRef] });
      toast.success("Market settled", { id: tid });
      void refresh();
    } catch (e) {
      toast.error((e as Error).message?.slice(0, 120) ?? "Settle failed", {
        id: tid,
      });
    } finally {
      setPending(null);
    }
  }, [marketRef, writeContractAsync, refresh]);

  if (!isConnected || !marketRef) return null;
  // No-op render if we're not the adjudicator authority for this market.
  if (!isAuthority) return null;

  const settled = adjudicator?.attestedOutcome !== null;

  return (
    <Card className="bg-raised border border-rule p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-ink">Operator Actions</h3>
        <span className="text-xs font-mono text-muted uppercase tracking-[0.12em]">
          {settled
            ? `SETTLED · winning=${
                adjudicator?.attestedOutcome === 1
                  ? "YES"
                  : adjudicator?.attestedOutcome === 0
                    ? "NO"
                    : "INVALID"
              }`
            : "OPEN"}
        </span>
      </div>
      <p className="text-xs text-muted mb-4">
        You are the registered adjudicator for this market. The lifecycle is
        three steps, not two: REQUEST LOCK moves it to Locked (no further
        trades), ATTEST records an outcome, and SETTLE finalises it once the
        veto window has passed. Attesting no longer settles on its own — that
        window is what makes `dispute` reachable at all. Only after SETTLE can
        holders redeem.
      </p>
      <div
        className="flex flex-wrap gap-3"
        data-testid="operator-actions-panel"
      >
        <Button
          className="btn btn-secondary"
          onClick={lock}
          disabled={pending !== null || settled}
          isLoading={pending === "lock"}
          data-testid="operator-request-lock"
        >
          REQUEST LOCK
        </Button>
        <Button
          className="btn btn-primary"
          onClick={() => attest(1, "attestYes")}
          disabled={pending !== null || settled}
          isLoading={pending === "attestYes"}
          data-testid="operator-attest-yes"
        >
          ATTEST YES
        </Button>
        <Button
          className="btn btn-primary"
          onClick={() => attest(0, "attestNo")}
          disabled={pending !== null || settled}
          isLoading={pending === "attestNo"}
          data-testid="operator-attest-no"
        >
          ATTEST NO
        </Button>
        <Button
          className="btn btn-secondary"
          onClick={() => attest(2, "attestInvalid")}
          disabled={pending !== null || settled}
          isLoading={pending === "attestInvalid"}
          data-testid="operator-attest-invalid"
        >
          ATTEST INVALID
        </Button>
        <Button
          className="btn btn-primary"
          onClick={settleMarket}
          disabled={pending !== null || !settled}
          isLoading={pending === "settle"}
          data-testid="operator-settle"
          title="Available once an outcome is attested and the veto window has passed"
        >
          SETTLE
        </Button>
      </div>
    </Card>
  );
}
