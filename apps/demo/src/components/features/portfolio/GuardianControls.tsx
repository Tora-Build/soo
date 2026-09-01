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
import {
  ShieldAlert,
  ShieldPlus,
  X,
  Loader2,
  ChevronRight,
} from "lucide-react";
import { Link } from "react-router-dom";

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
      className="mt-2 border border-warn/40 bg-warn/5 p-2.5 space-y-1.5"
      data-testid="veto-control"
    >
      <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-warn">
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
            className="px-2.5 py-1 font-mono text-[10px] font-bold uppercase border border-warn/50 text-warn hover:bg-warn/10 disabled:opacity-50"
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
                className="text-faint hover:text-neg disabled:opacity-50"
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

  const memberCount = set?.attestors.length ?? 0;
  // The program requires `1 <= threshold <= count`, so with an empty roster
  // EVERY threshold is rejected. Setting one used to build a transaction that
  // could only fail simulation; now the control says why it is not ready.
  const thresholdReady = memberCount > 0;
  const thresholdNum = Number(threshold);
  const thresholdValid =
    thresholdReady &&
    Number.isInteger(thresholdNum) &&
    thresholdNum >= 1 &&
    thresholdNum <= memberCount;

  return (
    <div className="mt-2" data-testid="committee-controls">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-accent hover:text-ink"
      >
        <ShieldPlus className="h-3.5 w-3.5" />
        {set
          ? t("committee.toggle", {
              defaultValue: "Committee ({{threshold}}-of-{{count}})",
              threshold: set.threshold,
              count: memberCount,
            })
          : t("committee.create", { defaultValue: "Convene a committee" })}
      </button>

      {open && (
        <div className="mt-2 border border-rule bg-raised p-4 space-y-4">
          {/* One line, not a paragraph. */}
          <p className="text-sm text-muted leading-relaxed">
            {t("committee.hint", {
              defaultValue:
                "Members vote in public. The vote that reaches the threshold writes the ruling — you can still rule alone.",
            })}
          </p>

          {/* ── roster ── */}
          {memberCount > 0 && (
            <ul className="space-y-1.5">
              {(set?.attestors ?? []).map((a, i) => (
                <li
                  key={a}
                  className="flex items-center gap-3 border border-rule bg-inset px-3 py-2"
                >
                  <span className="font-mono text-xs text-ink truncate flex-1">
                    {a.slice(0, 6)}…{a.slice(-6)}
                  </span>
                  <span
                    className={cn(
                      "font-mono text-xs font-bold",
                      set!.votes[i] === null ? "text-faint" : "text-accent",
                    )}
                  >
                    {word(set!.votes[i])}
                  </span>
                  {isEntryAuthority && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => write(["remove", a], "Attestor removed")}
                      className="text-muted hover:text-neg disabled:opacity-50"
                      aria-label={`Remove attestor ${a}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {isEntryAuthority && (
            <>
              {/* ── add a member ── */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <label
                    htmlFor="attestor-add"
                    className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted"
                  >
                    {t("committee.addLabel", { defaultValue: "Add member" })}
                  </label>
                  {/* Picking a stranger to rule your market should start from
                      their record, not from a blank box. */}
                  <Link
                    to="/adjudicators"
                    className="inline-flex items-center gap-0.5 font-mono text-[11px] uppercase tracking-[0.12em] text-accent hover:underline"
                  >
                    {t("committee.browse", { defaultValue: "Browse records" })}
                    <ChevronRight className="h-3 w-3" />
                  </Link>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="attestor-add"
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={t("committee.addPlaceholder", {
                      defaultValue: "Paste an attestor address",
                    })}
                    className="flex-1 min-w-0 bg-inset border border-rule px-3 py-2 font-mono text-xs text-ink placeholder:text-faint focus:outline-none focus:border-accent"
                    data-testid="attestor-add-input"
                  />
                  <button
                    type="button"
                    disabled={busy || !input.trim() || memberCount >= 5}
                    onClick={() => write(["add", input.trim()], "Attestor added")}
                    className="shrink-0 px-3 py-2 font-mono text-xs font-bold uppercase tracking-[0.12em] border border-accent bg-accent text-canvas hover:opacity-90 disabled:opacity-40"
                  >
                    Add
                  </button>
                </div>
                {memberCount >= 5 && (
                  <p className="text-xs text-muted">
                    {t("committee.full", {
                      defaultValue: "Five members is the maximum.",
                    })}
                  </p>
                )}
              </div>

              {/* ── threshold ── */}
              <div className="space-y-1.5">
                <label
                  htmlFor="attestor-threshold"
                  className="block font-mono text-[11px] uppercase tracking-[0.12em] text-muted"
                >
                  {t("committee.thresholdLabel", {
                    defaultValue: "Votes needed to rule",
                  })}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="attestor-threshold"
                    type="number"
                    min="1"
                    max={memberCount || 1}
                    disabled={!thresholdReady}
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    placeholder={memberCount ? `1–${memberCount}` : "—"}
                    className="w-24 bg-inset border border-rule px-3 py-2 font-mono text-xs text-ink placeholder:text-faint focus:outline-none focus:border-accent disabled:opacity-40"
                    data-testid="attestor-threshold-input"
                  />
                  <button
                    type="button"
                    disabled={busy || !thresholdValid}
                    onClick={() =>
                      write(["threshold", "", thresholdNum], "Threshold set")
                    }
                    className="px-3 py-2 font-mono text-xs font-bold uppercase tracking-[0.12em] border border-accent text-accent hover:bg-accent hover:text-canvas disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-accent"
                  >
                    {t("committee.setThreshold", { defaultValue: "Set" })}
                  </button>
                  {thresholdValid && (
                    <span className="text-xs text-muted">
                      {t("committee.ofMembers", {
                        defaultValue: "of {{count}} members",
                        count: memberCount,
                      })}
                    </span>
                  )}
                </div>
                {!thresholdReady && (
                  <p className="text-xs text-warn">
                    {t("committee.needMembers", {
                      defaultValue: "Add at least one member first.",
                    })}
                  </p>
                )}
              </div>
            </>
          )}

          {/* ── ballots ── */}
          {isMember && canVoteNow && (set?.threshold ?? 0) >= 1 && (
            <div className="pt-3 border-t border-rule">
              <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-accent mb-2">
                {t("committee.yourBallot", { defaultValue: "Your ballot" })}
              </p>
              <div className="flex items-center gap-2">
                {([1, 0, 2] as const).map((o) => (
                  <button
                    key={o}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      write(["vote", o], "Ballot cast — quorum writes the ruling")
                    }
                    className="flex-1 px-3 py-2 font-mono text-xs font-bold uppercase tracking-[0.12em] border border-accent text-accent hover:bg-accent hover:text-canvas disabled:opacity-40"
                    data-testid={`ballot-${o}`}
                  >
                    {word(o)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
