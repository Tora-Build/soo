import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useWriteContract } from "@/lib/chain-shim";
import toast from "react-hot-toast";
import { PublicKey } from "@solana/web3.js";
import { useDemo } from "../../../lib/DemoContext";
import { demoConfig } from "../../../lib/config";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";

interface DismissMarketPanelProps {
  marketRef?: string | null;
}

interface DismissState {
  creator: string;
  trialEndAt: bigint;
  isGraduated: boolean;
  isDismissed: boolean;
  now: bigint;
}

const REFRESH_MS = 8_000;
const SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111";

export function DismissMarketPanel({ marketRef }: DismissMarketPanelProps) {
  const { isConnected, address } = useAccount();
  const demo = useDemo();
  const adapter = demo?.adapter ?? null;
  const { writeContractAsync } = useWriteContract();
  const activeMarketRef = marketRef ?? demoConfig.marketRef;
  const userRef = useMemo(
    () => (address ? `sol:${String(address).replace(/^0x/, "")}` : null),
    [address],
  );
  const [state, setState] = useState<DismissState | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    if (!adapter || !activeMarketRef) {
      setState(null);
      return;
    }
    try {
      const [amm, now] = await Promise.all([
        adapter.readAmmState(activeMarketRef),
        readOnchainClock(adapter.connection),
      ]);
      setState({
        creator: amm.creator,
        trialEndAt: amm.trialEndAt,
        isGraduated: amm.isGraduated,
        isDismissed: amm.isDismissed,
        now,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[DismissMarketPanel] refresh failed", e);
      setState(null);
    }
  }, [adapter, activeMarketRef]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const dismiss = useCallback(async () => {
    if (!activeMarketRef) return;
    const tid = toast.loading("Dismissing market…");
    setPending(true);
    try {
      await writeContractAsync({
        functionName: "dismissMarket",
        args: [activeMarketRef],
      });
      toast.success("Market dismissed", { id: tid });
      void refresh();
    } catch (e) {
      toast.error((e as Error).message?.slice(0, 100) ?? "Dismiss failed", {
        id: tid,
      });
    } finally {
      setPending(false);
    }
  }, [activeMarketRef, refresh, writeContractAsync]);

  if (!isConnected || !activeMarketRef || !state || !userRef) return null;
  if (state.creator !== userRef) return null;
  if (state.now < state.trialEndAt) return null;
  if (state.isDismissed || state.isGraduated) return null;

  return (
    <Card className="bg-raised border border-rule p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-ink">Dismiss Market</h3>
        <span className="text-xs font-mono text-muted uppercase tracking-[0.12em]">
          trial ended
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 mb-4">
        <Stat label="Market" value={activeMarketRef.replace(/^sol:/, "").slice(0, 12) + "…"} />
        <Stat label="Trial End" value={String(state.trialEndAt)} />
        <Stat label="Clock" value={String(state.now)} />
      </div>
      <Button
        className="btn btn-primary"
        onClick={dismiss}
        disabled={pending}
        isLoading={pending}
        data-testid="dismiss-market-button"
      >
        DISMISS MARKET
      </Button>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-rule bg-inset p-3">
      <p className="text-[10px] font-mono uppercase tracking-[0.12em] text-muted">
        {label}
      </p>
      <p className="mt-1 text-sm font-mono text-ink truncate">{value}</p>
    </div>
  );
}

async function readOnchainClock(connection: {
  getAccountInfo(pubkey: PublicKey): Promise<{ data: Buffer } | null>;
}): Promise<bigint> {
  const info = await connection.getAccountInfo(new PublicKey(SYSVAR_CLOCK));
  if (!info) return BigInt(Math.floor(Date.now() / 1000));
  return info.data.readBigInt64LE(32);
}
