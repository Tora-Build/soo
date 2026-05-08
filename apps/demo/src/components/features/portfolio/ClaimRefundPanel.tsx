import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useWriteContract } from "@/lib/chain-shim";
import toast from "react-hot-toast";
import { useDemo } from "../../../lib/DemoContext";
import { demoConfig } from "../../../lib/config";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";

interface ClaimRefundPanelProps {
  marketRef?: string | null;
}

interface RefundState {
  isDismissed: boolean;
  lockedCostUsdc: bigint;
}

const REFRESH_MS = 8_000;

export function ClaimRefundPanel({ marketRef }: ClaimRefundPanelProps) {
  const { isConnected, address } = useAccount();
  const demo = useDemo();
  const adapter = demo?.adapter ?? null;
  const { writeContractAsync } = useWriteContract();
  const activeMarketRef = marketRef ?? demoConfig.marketRef;
  const userRef = useMemo(
    () => (address ? `sol:${String(address).replace(/^0x/, "")}` : null),
    [address],
  );
  const [state, setState] = useState<RefundState | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    if (!adapter || !activeMarketRef || !userRef) {
      setState(null);
      return;
    }
    try {
      const amm = await adapter.readAmmState(activeMarketRef, userRef);
      setState({
        isDismissed: amm.isDismissed,
        lockedCostUsdc: amm.lockedCostUsdc,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[ClaimRefundPanel] refresh failed", e);
      setState(null);
    }
  }, [adapter, activeMarketRef, userRef]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const claim = useCallback(async () => {
    if (!activeMarketRef) return;
    const tid = toast.loading("Claiming refund…");
    setPending(true);
    try {
      await writeContractAsync({
        functionName: "claimRefund",
        args: [activeMarketRef],
      });
      toast.success("Refund claimed", { id: tid });
      void refresh();
    } catch (e) {
      toast.error(
        (e as Error).message?.slice(0, 100) ?? "Refund claim failed",
        { id: tid },
      );
    } finally {
      setPending(false);
    }
  }, [activeMarketRef, refresh, writeContractAsync]);

  if (!isConnected || !activeMarketRef || !state) return null;
  if (!state.isDismissed || state.lockedCostUsdc <= 0n) return null;

  return (
    <Card className="bg-raised border border-rule p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-ink">Claim Refund</h3>
        <span className="text-xs font-mono text-muted uppercase tracking-[0.12em]">
          dismissed
        </span>
      </div>
      <div className="border border-rule bg-inset p-3 mb-4">
        <p className="text-[10px] font-mono uppercase tracking-[0.12em] text-muted">
          Locked cost
        </p>
        <p className="mt-1 text-sm font-mono text-ink">
          ${formatUsdc(state.lockedCostUsdc)}
        </p>
      </div>
      <Button
        className="btn btn-primary"
        onClick={claim}
        disabled={pending}
        isLoading={pending}
        data-testid="claim-refund-button"
      >
        CLAIM REFUND
      </Button>
    </Card>
  );
}

function formatUsdc(v: bigint): string {
  return (Number(v) / 1_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}
