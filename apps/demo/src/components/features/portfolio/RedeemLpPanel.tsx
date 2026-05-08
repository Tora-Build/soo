import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useWriteContract } from "@/lib/chain-shim";
import toast from "react-hot-toast";
import { useDemo } from "../../../lib/DemoContext";
import { demoConfig } from "../../../lib/config";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";

interface RedeemLpPanelProps {
  marketRef?: string | null;
}

interface LpState {
  isGraduated: boolean;
  lpBalance: bigint;
  lpSupply: bigint;
  lpYieldVaultAmount: bigint;
}

const REFRESH_MS = 8_000;
const LP_DECIMALS = 6;

export function RedeemLpPanel({ marketRef }: RedeemLpPanelProps) {
  const { isConnected, address } = useAccount();
  const demo = useDemo();
  const adapter = demo?.adapter ?? null;
  const { writeContractAsync } = useWriteContract();
  const activeMarketRef = marketRef ?? demoConfig.marketRef;
  const userRef = useMemo(
    () => (address ? `sol:${String(address).replace(/^0x/, "")}` : null),
    [address],
  );
  const [state, setState] = useState<LpState | null>(null);
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    if (!adapter || !activeMarketRef || !userRef) {
      setState(null);
      return;
    }
    try {
      const info = await adapter.readLpRedemption(activeMarketRef, userRef);
      setState({
        isGraduated: info.isGraduated,
        lpBalance: info.lpBalance,
        lpSupply: info.lpSupply,
        lpYieldVaultAmount: info.lpYieldVaultAmount,
      });
      setAmount((prev) => prev || formatLp(info.lpBalance));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[RedeemLpPanel] refresh failed", e);
      setState(null);
    }
  }, [adapter, activeMarketRef, userRef]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const lpAmount = useMemo(() => parseLpAmount(amount), [amount]);
  const expectedPayout =
    state && state.lpSupply > 0n && lpAmount > 0n
      ? (state.lpYieldVaultAmount * lpAmount) / state.lpSupply
      : 0n;
  const amountValid =
    !!state && lpAmount > 0n && lpAmount <= state.lpBalance && !pending;

  const redeem = useCallback(async () => {
    if (!activeMarketRef || lpAmount <= 0n) return;
    const tid = toast.loading("Redeeming LP…");
    setPending(true);
    try {
      await writeContractAsync({
        functionName: "redeemLp",
        args: [activeMarketRef, lpAmount],
      });
      toast.success("LP redeemed", { id: tid });
      setAmount("");
      void refresh();
    } catch (e) {
      toast.error((e as Error).message?.slice(0, 100) ?? "Redeem LP failed", {
        id: tid,
      });
    } finally {
      setPending(false);
    }
  }, [activeMarketRef, lpAmount, refresh, writeContractAsync]);

  if (!isConnected || !activeMarketRef || !state) return null;
  if (!state.isGraduated || state.lpBalance <= 0n) return null;

  return (
    <Card className="bg-raised border border-rule p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-ink">Redeem LP</h3>
        <span className="text-xs font-mono text-muted uppercase tracking-[0.12em]">
          graduated
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 mb-4">
        <Stat label="LP balance" value={formatLp(state.lpBalance)} />
        <Stat label="Yield vault" value={`$${formatUsdc(state.lpYieldVaultAmount)}`} />
        <Stat label="Expected payout" value={`$${formatUsdc(expectedPayout)}`} />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="block text-[10px] font-mono uppercase tracking-[0.12em] text-muted mb-1">
            LP amount
          </span>
          <input
            type="number"
            min={0}
            step="0.000001"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-inset border border-rule px-3 py-2 text-sm font-mono text-ink"
            data-testid="redeem-lp-amount"
          />
        </label>
        <Button
          className="btn btn-primary"
          onClick={redeem}
          disabled={!amountValid}
          isLoading={pending}
          data-testid="redeem-lp-button"
        >
          REDEEM LP
        </Button>
      </div>
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

function parseLpAmount(v: string): bigint {
  const trimmed = v.trim();
  if (!trimmed) return 0n;
  const [wholeRaw, fracRaw = ""] = trimmed.split(".");
  if (!/^\d+$/.test(wholeRaw || "0") || !/^\d*$/.test(fracRaw)) return 0n;
  const whole = BigInt(wholeRaw || "0");
  const frac = BigInt((fracRaw.slice(0, LP_DECIMALS).padEnd(LP_DECIMALS, "0")) || "0");
  return whole * 1_000_000n + frac;
}

function formatLp(v: bigint): string {
  return (Number(v) / 1_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}

function formatUsdc(v: bigint): string {
  return (Number(v) / 1_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}
