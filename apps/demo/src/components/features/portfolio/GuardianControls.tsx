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

function useAttestorSet(market: string): {
  set: { attestors: string[]; votes: Array<number | null>; threshold: number } | null;
  loaded: boolean;
  reload: () => void;
} {
  const demo = useDemo();
  const [set, setSet] = useState<{
    attestors: string[];
    votes: Array<number | null>;
    threshold: number;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    demo?.adapter
      .readAttestorSet(`sol:${market}`)
      .then((r) => {
        if (live) {
          setSet(r);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [demo, market, nonce]);
  return { set, loaded, reload: () => setNonce((n) => n + 1) };
}

/**
 * Committee controls: the entry authority's roster/threshold editor, and —
 * on a LOCKED, unattested market — ballot buttons for any wallet on the
 * roster. Votes are public and mutable until quorum fires; the tally is
 * shown per member so a stalled committee is visibly stalled.
 */
export function CommitteeControls({
  market,
  isEntryAuthority,
  canVoteNow,
}: {
  market: string;
  isEntryAuthority: boolean;
  /** Market is Locked and unattested — ballots are actionable. */
  canVoteNow: boolean;
}) {
  const { t } = useTranslation();
  const { address } = useAccount();
  const wallet = address ? String(address).replace(/^0x/, "") : null;
  const { writeContractAsync } = useWriteContract();
  const { set, loaded, reload } = useAttestorSet(market);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [threshold, setThreshold] = useState("");
  const [busy, setBusy] = useState(false);

  const isMember = wallet !== null && (set?.attestors ?? []).includes(wallet);
  if (!loaded) return null;
  if (!set && !isEntryAuthority) return null;

  const write = async (args: unknown[], done: string) => {
    setBusy(true);
    try {
      await writeContractAsync({
        functionName: args[0] === "vote" ? "attestVote" : "attestorUpdate",
        args: args[0] === "vote" ? [`sol:${market}`, args[1]] : [`sol:${market}`, ...args],
      } as never);
      toast.success(done);
      setInput("");
      reload();
    } catch (e) {
      toast.error((e as Error).message?.slice(0, 120) ?? "Failed");
    } finally {
      setBusy(false);
    }
  };

  const word = (v: number | null) =>
    v === 1 ? "YES" : v === 0 ? "NO" : v === 2 ? "INVALID" : "—";

  return (
    <div className="mt-1.5" data-testid="committee-controls">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted hover:text-ink"
      >
        <ShieldPlus className="h-3 w-3" />
        {set
          ? t("committee.toggle", {
              defaultValue: "Committee ({{threshold}}-of-{{count}})",
              threshold: set.threshold,
              count: set.attestors.length,
            })
          : t("committee.create", { defaultValue: "Convene a committee" })}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 border border-rule bg-inset p-2.5">
          <p className="text-[11px] text-muted leading-relaxed">
            {t("committee.hint", {
              defaultValue:
                "M-of-N attestation: the ballot that reaches the threshold writes the ruling — same veto window and settlement as a single key. Your unilateral attest stays available.",
            })}
          </p>
          {(set?.attestors ?? []).map((a, i) => (
            <div key={a} className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-muted truncate flex-1">
                {a}
              </span>
              <span className="font-mono text-[10px] text-faint">
                {word(set!.votes[i])}
              </span>
              {isEntryAuthority && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => write(["remove", a], "Attestor removed")}
                  className="text-faint hover:text-red-400 disabled:opacity-50"
                  aria-label={`Remove attestor ${a}`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
          {isEntryAuthority && (
            <>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={t("committee.addPlaceholder", {
                    defaultValue: "attestor pubkey",
                  })}
                  className="flex-1 bg-canvas border border-rule px-2 py-1 font-mono text-[10px] text-ink focus:outline-none focus:border-accent"
                  data-testid="attestor-add-input"
                />
                <button
                  type="button"
                  disabled={busy || !input.trim()}
                  onClick={() => write(["add", input.trim()], "Attestor added")}
                  className="px-2 py-1 font-mono text-[10px] font-bold uppercase border border-rule text-ink hover:bg-raised disabled:opacity-50"
                >
                  Add
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min="1"
                  max={set?.attestors.length ?? 5}
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  placeholder="M"
                  className="w-16 bg-canvas border border-rule px-2 py-1 font-mono text-[10px] text-ink focus:outline-none focus:border-accent"
                  data-testid="attestor-threshold-input"
                />
                <button
                  type="button"
                  disabled={busy || !threshold}
                  onClick={() =>
                    write(["threshold", "", Number(threshold)], "Threshold set")
                  }
                  className="px-2 py-1 font-mono text-[10px] font-bold uppercase border border-rule text-ink hover:bg-raised disabled:opacity-50"
                >
                  {t("committee.setThreshold", { defaultValue: "Set threshold" })}
                </button>
              </div>
            </>
          )}
          {isMember && canVoteNow && (set?.threshold ?? 0) >= 1 && (
            <div className="flex items-center gap-1.5 pt-1 border-t border-rule">
              <span className="font-mono text-[10px] text-accent uppercase tracking-[0.12em]">
                {t("committee.yourBallot", { defaultValue: "your ballot:" })}
              </span>
              {([1, 0, 2] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    write(["vote", o], "Ballot cast — quorum writes the ruling")
                  }
                  className="px-2.5 py-1 font-mono text-[10px] font-bold uppercase border border-accent/60 text-accent hover:bg-accent hover:text-canvas disabled:opacity-50"
                  data-testid={`ballot-${o}`}
                >
                  {word(o)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
