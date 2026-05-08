// Pending sell-lock entries + per-entry claim button. The AMM's
// `sell_positions` ix routes proceeds into a per-entry LockEntry PDA
// with a 24h cooldown; `claim_unlocked` drains one matured entry per
// call. Without surface here, users have no way to recover proceeds
// post-cooldown without CLI tooling.
//
// SDK source: SolanaChainAdapter.readPendingUnlocks.
// Submit: chain-shim writeContract({ functionName: "claimUnlocked",
//          args: [{ market, lockEntry }] }).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useWriteContract } from "@/lib/chain-shim";
import toast from "react-hot-toast";
import { useDemo } from "../../../lib/DemoContext";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { demoConfig } from "../../../lib/config";

interface PendingUnlock {
  lockEntry: string;
  amountUsdc: bigint;
  unlockAt: bigint;
  nonce: bigint;
}

const REFRESH_MS = 8_000;

export function ClaimUnlockedPanel() {
  const { isConnected, address } = useAccount();
  const demo = useDemo();
  const adapter = demo?.adapter ?? null;
  const { writeContractAsync } = useWriteContract();
  const [entries, setEntries] = useState<PendingUnlock[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingNonce, setPendingNonce] = useState<bigint | null>(null);
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));

  const marketRef = demoConfig.marketRef;
  const userRef = useMemo(
    // chain-shim's `useAccount().address` is `0x<base58>` (EVM-shaped slot);
    // strip the prefix and prepend `sol:` for the SDK.
    () => (address ? `sol:${String(address).replace(/^0x/, "")}` : null),
    [address],
  );

  const refresh = useCallback(async () => {
    if (!adapter || !marketRef || !userRef) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      const list = await adapter.readPendingUnlocks(marketRef, userRef);
      setEntries(list);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[ClaimUnlockedPanel] readPendingUnlocks failed", e);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [adapter, marketRef, userRef]);

  // Track on-chain Clock.unix_timestamp instead of wall-clock — these
  // diverge under Surfpool's surfnet_timeTravel cheatcode (advances the
  // on-chain clock without moving Date.now()), and the program's
  // `now >= unlock_at` gate uses on-chain time. Falling back to
  // wall-clock if the read fails keeps the production path identical.
  const refreshNow = useCallback(async () => {
    if (!adapter) {
      setNow(BigInt(Math.floor(Date.now() / 1000)));
      return;
    }
    try {
      const SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111";
      const { PublicKey } = await import("@solana/web3.js");
      const info = await adapter.connection.getAccountInfo(
        new PublicKey(SYSVAR_CLOCK),
      );
      if (info) {
        // Layout: slot u64 @ 0, epoch_start u64 @ 8, epoch u64 @ 16,
        //         leader_schedule_epoch u64 @ 24, unix_timestamp i64 @ 32
        setNow(info.data.readBigInt64LE(32));
        return;
      }
    } catch {
      // fall through to wall-clock
    }
    setNow(BigInt(Math.floor(Date.now() / 1000)));
  }, [adapter]);

  useEffect(() => {
    void refresh();
    void refreshNow();
    const id = window.setInterval(() => {
      void refreshNow();
      void refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh, refreshNow]);

  const claim = useCallback(
    async (entry: PendingUnlock) => {
      if (!marketRef) return;
      const tid = toast.loading(
        `Claiming ${(Number(entry.amountUsdc) / 1_000_000).toFixed(2)} USDC…`,
      );
      setPendingNonce(entry.nonce);
      try {
        await writeContractAsync({
          functionName: "claimUnlocked",
          args: [{ market: marketRef, lockEntry: entry.lockEntry }],
        });
        toast.success("Proceeds claimed", { id: tid });
        void refresh();
      } catch (e) {
        toast.error((e as Error).message?.slice(0, 80) ?? "Claim failed", {
          id: tid,
        });
      } finally {
        setPendingNonce(null);
      }
    },
    [marketRef, writeContractAsync, refresh],
  );

  if (!isConnected) return null;
  if (!loading && entries.length === 0) return null;

  return (
    <Card className="bg-raised border border-rule p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-ink">Pending Unlocks</h3>
        <span className="text-xs font-mono text-muted uppercase tracking-[0.12em]">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
      </div>
      <p className="text-xs text-muted mb-4">
        Sell proceeds are locked for 24h before they can be claimed back to your
        USDC ATA. Each row below corresponds to one lock entry — once the
        countdown hits zero the CLAIM button enables.
      </p>
      <div className="space-y-2" data-testid="pending-unlocks-panel">
        {entries.map((e) => {
          const ready = now >= e.unlockAt;
          const remainingS = ready ? 0 : Number(e.unlockAt - now);
          const hh = Math.floor(remainingS / 3600);
          const mm = Math.floor((remainingS % 3600) / 60);
          const ss = remainingS % 60;
          const usdc = (Number(e.amountUsdc) / 1_000_000).toFixed(2);
          return (
            <div
              key={String(e.nonce)}
              className="flex items-center justify-between border border-rule bg-inset p-3"
              data-testid={`pending-unlocks-row-${String(e.nonce)}`}
            >
              <div className="font-mono text-sm">
                <span className="text-ink">${usdc}</span>{" "}
                <span className="text-muted text-xs">
                  · nonce {String(e.nonce)} ·{" "}
                  {ready ? "READY" : `unlocks in ${hh}h ${mm}m ${ss}s`}
                </span>
              </div>
              <Button
                className="btn btn-primary"
                onClick={() => claim(e)}
                disabled={!ready || pendingNonce !== null}
                isLoading={pendingNonce === e.nonce}
                data-testid={`pending-unlocks-claim-${String(e.nonce)}`}
              >
                CLAIM
              </Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
