/**
 * Guardian-side UI: the veto, and the roster that shares it.
 *
 * `VetoControl` renders during a market's dispute window for anyone entitled
 * to veto — the dispute authority, or a deputized guardian (the roster is
 * read on mount). The buttons state the claim being put on record; the copy
 * says what the veto actually does now: reject and hand back, never decide.
 *
 * `GuardianManager` is the dispute authority's roster editor, shown on their
 * own market rows.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { ShieldAlert, ShieldPlus, X, Loader2 } from "lucide-react";

import { useDemo } from "../../../lib/DemoContext";
import { useAccount, useWriteContract } from "@/lib/chain-shim";
import { cn } from "../../../lib/utils";

function useGuardianRoster(market: string): {
  roster: string[] | null;
  reload: () => void;
} {
  const demo = useDemo();
  const [roster, setRoster] = useState<string[] | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    demo?.adapter
      .readGuardianSet(`sol:${market}`)
      .then((r) => {
        if (live) setRoster(r ?? []);
      })
      .catch(() => {
        if (live) setRoster([]);
      });
    return () => {
      live = false;
    };
  }, [demo, market, nonce]);
  return { roster, reload: () => setNonce((n) => n + 1) };
}

export function VetoControl({
  market,
  isDisputeAuthority,
}: {
  market: string;
  isDisputeAuthority: boolean;
}) {
  const { t } = useTranslation();
  const { address } = useAccount();
  const wallet = address ? String(address).replace(/^0x/, "") : null;
  const { writeContractAsync } = useWriteContract();
  const { roster } = useGuardianRoster(market);
  const [busy, setBusy] = useState(false);

  const mayVeto =
    isDisputeAuthority || (wallet !== null && (roster ?? []).includes(wallet));
  if (!mayVeto) return null;

  const veto = async (claim: 0 | 1 | 2) => {
    setBusy(true);
    try {
      await writeContractAsync({
        functionName: "dispute",
        args: [`sol:${market}`, claim],
      } as never);
      toast.success(
        t("veto.done", {
          defaultValue:
            "Ruling rejected — the adjudicator must rule again, and the new ruling gets its own window",
        }),
      );
    } catch (e) {
      toast.error((e as Error).message?.slice(0, 120) ?? "Veto failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="mt-2 border border-amber-500/40 bg-amber-500/5 p-2.5 space-y-1.5"
      data-testid="veto-control"
    >
      <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-400">
        <ShieldAlert className="h-3 w-3" />
        {t("veto.title", { defaultValue: "Guardian veto — reject this ruling" })}
      </p>
      <p className="text-[11px] text-muted leading-relaxed">
        {t("veto.hint", {
          defaultValue:
            "A veto clears the ruling and hands the market back for re-resolution. It cannot pick the outcome — your claim below is recorded publicly, not enacted.",
        })}
      </p>
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-faint">
          {t("veto.claim", { defaultValue: "my claim:" })}
        </span>
        {([1, 0, 2] as const).map((claim) => (
          <button
            key={claim}
            type="button"
            disabled={busy}
            onClick={() => veto(claim)}
            className="px-2.5 py-1 font-mono text-[10px] font-bold uppercase border border-amber-500/50 text-amber-400 hover:bg-amber-500/10 disabled:opacity-50"
            data-testid={`veto-claim-${claim}`}
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : claim === 1 ? (
              "YES"
            ) : claim === 0 ? (
              "NO"
            ) : (
              "INVALID"
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

export function GuardianManager({ market }: { market: string }) {
  const { t } = useTranslation();
  const { writeContractAsync } = useWriteContract();
  const { roster, reload } = useGuardianRoster(market);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const update = async (guardian: string, remove: boolean) => {
    setBusy(true);
    try {
      await writeContractAsync({
        functionName: "guardianUpdate",
        args: [`sol:${market}`, guardian, remove],
      } as never);
      toast.success(remove ? "Guardian removed" : "Guardian deputized");
      setInput("");
      reload();
    } catch (e) {
      toast.error((e as Error).message?.slice(0, 120) ?? "Update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5" data-testid="guardian-manager">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted hover:text-ink"
      >
        <ShieldPlus className="h-3 w-3" />
        {t("guardians.toggle", {
          defaultValue: "Guardians ({{count}}/5)",
          count: roster?.length ?? 0,
        })}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 border border-rule bg-inset p-2.5">
          <p className="text-[11px] text-muted leading-relaxed">
            {t("guardians.hint", {
              defaultValue:
                "Deputized keys that may raise the veto alongside you — many eyes instead of one point of capture.",
            })}
          </p>
          {(roster ?? []).map((g) => (
            <div key={g} className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-muted truncate">{g}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => update(g, true)}
                className="text-faint hover:text-red-400 disabled:opacity-50"
                aria-label={`Remove guardian ${g}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t("guardians.placeholder", {
                defaultValue: "guardian pubkey",
              })}
              className="flex-1 bg-canvas border border-rule px-2 py-1 font-mono text-[10px] text-ink focus:outline-none focus:border-accent"
              data-testid="guardian-add-input"
            />
            <button
              type="button"
              disabled={busy || !input.trim()}
              onClick={() => update(input.trim(), false)}
              className={cn(
                "px-2 py-1 font-mono text-[10px] font-bold uppercase border border-rule text-ink hover:bg-raised disabled:opacity-50",
              )}
              data-testid="guardian-add-button"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
