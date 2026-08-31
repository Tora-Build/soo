/**
 * The bonded-resolution console — the optimistic lifecycle, on the market page.
 *
 * Renders only where the mechanism is live: a market with NO registered
 * adjudicator entry (the program's eligibility rule) that is past its
 * deadline, or one that already carries a proposal. Walks every stage:
 * propose with a bond → challenge window countdown → challenge or finalize →
 * arbitration (buttons appear only for the designated arbiter) → resolved.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { Scale, Loader2 } from "lucide-react";

import { useAccount, useWriteContract } from "@/lib/chain-shim";
import {
  useResolutionStates,
  normalizeMarketKey,
} from "../../../features/arena/useResolutionStates";
import { cn } from "../../../lib/utils";

/** Mirrors the program's OPT_CHALLENGE_WINDOW_SECS (devnet build). */
const CHALLENGE_WINDOW_SEC = 600;

const OUTCOME_WORD = ["NO", "YES", "INVALID"] as const;

export function OptimisticConsole({ marketAddress }: { marketAddress: string }) {
  const { t } = useTranslation();
  const { address } = useAccount();
  const { byMarket, proposalsByMarket, hasLoaded } = useResolutionStates();
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState<string | null>(null);
  const [bond, setBond] = useState("1");

  const key = normalizeMarketKey(marketAddress) ?? "";
  const state = byMarket[key];
  const proposal = proposalsByMarket[key];
  const wallet = address ? String(address).replace(/^0x/, "") : null;

  if (!hasLoaded || !state) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const pastDeadline =
    Number(state.deadline) > 1_000_000_000 && nowSec >= Number(state.deadline);
  const eligible =
    !state.adjudicatorEntry &&
    state.lifecycle === "Open" &&
    !state.isDismissed;

  // Nothing optimistic can ever happen here — stay out of the way.
  if (!proposal && !(eligible && pastDeadline)) return null;

  const run = async (label: string, fn: string, args: unknown[], done: string) => {
    setBusy(label);
    try {
      await writeContractAsync({ functionName: fn, args } as never);
      toast.success(done);
    } catch (e) {
      toast.error((e as Error).message?.slice(0, 120) ?? "Transaction failed");
    } finally {
      setBusy(null);
    }
  };

  const windowEndsAt = proposal ? Number(proposal.proposedAt) + CHALLENGE_WINDOW_SEC : 0;
  const windowOpen = proposal && nowSec < windowEndsAt;
  const isArbiter = wallet === state.adjudicator;

  return (
    <div
      className="border border-rule bg-raised p-4 space-y-3"
      data-testid="optimistic-console"
    >
      <h3 className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.12em] text-muted">
        <Scale className="h-3.5 w-3.5 text-accent" />
        {t("optimistic.title", { defaultValue: "Bonded resolution" })}
      </h3>

      {!proposal ? (
        <>
          <p className="text-sm text-muted leading-relaxed">
            {t("optimistic.proposeHint", {
              defaultValue:
                "This market has no adjudicator — anyone may assert the outcome by posting a bond. If nobody challenges within 10 minutes, the assertion settles the market and the bond returns. A false assertion loses its bond to the challenger.",
            })}
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1"
              step="0.5"
              value={bond}
              onChange={(e) => setBond(e.target.value)}
              className="w-24 bg-inset border border-rule px-2 py-2 font-mono text-xs text-ink focus:outline-none focus:border-accent"
              data-testid="opt-bond-input"
            />
            <span className="font-mono text-[10px] text-faint">USDC bond</span>
            {[1, 0].map((outcome) => (
              <button
                key={outcome}
                type="button"
                disabled={busy !== null || Number(bond) < 1}
                onClick={() =>
                  run(
                    "propose",
                    "optPropose",
                    [
                      `sol:${key}`,
                      outcome,
                      BigInt(Math.round(Number(bond) * 1_000_000)),
                    ],
                    "Assertion posted — the challenge clock is running",
                  )
                }
                className={cn(
                  "px-4 py-2 font-mono text-xs font-bold uppercase tracking-[0.1em] border transition-all disabled:opacity-50",
                  outcome === 1
                    ? "border-accent text-accent hover:bg-accent hover:text-canvas"
                    : "border-rule text-ink hover:bg-inset",
                )}
                data-testid={`opt-propose-${OUTCOME_WORD[outcome].toLowerCase()}`}
              >
                {busy === "propose" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  `Assert ${OUTCOME_WORD[outcome]}`
                )}
              </button>
            ))}
          </div>
        </>
      ) : proposal.resolved ? (
        <p className="font-mono text-xs text-muted">
          {t("optimistic.resolved", {
            defaultValue: "Bonded resolution complete — outcome {{outcome}}.",
            outcome: OUTCOME_WORD[proposal.outcome] ?? "?",
          })}
        </p>
      ) : proposal.challenger ? (
        <>
          <p className="text-sm text-muted leading-relaxed">
            <span className="text-warn font-semibold">
              {t("optimistic.challenged", { defaultValue: "CHALLENGED." })}
            </span>{" "}
            {t("optimistic.challengedDetail", {
              defaultValue:
                "Assertion {{outcome}} was met with a matching counter-bond. The market's designated arbiter now rules; the loser's bond pays the winner.",
              outcome: OUTCOME_WORD[proposal.outcome] ?? "?",
            })}
          </p>
          {isArbiter && (
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent">
                {t("optimistic.youArbiter", { defaultValue: "You are the arbiter — rule:" })}
              </span>
              {[1, 0, 2].map((outcome) => (
                <button
                  key={outcome}
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    run(
                      "arbitrate",
                      "optArbitrate",
                      [`sol:${key}`, outcome],
                      "Ruled — the pot goes to whoever the ruling favors",
                    )
                  }
                  className="px-3 py-1.5 font-mono text-xs font-bold uppercase border border-rule text-ink hover:bg-inset disabled:opacity-50"
                  data-testid={`opt-arbitrate-${OUTCOME_WORD[outcome].toLowerCase()}`}
                >
                  {OUTCOME_WORD[outcome]}
                </button>
              ))}
            </div>
          )}
        </>
      ) : windowOpen ? (
        <>
          <p className="text-sm text-muted leading-relaxed">
            {t("optimistic.pending", {
              defaultValue:
                "Assertion: {{outcome}}, bond {{bond}} USDC. Challenge window closes in {{mins}}m — a matching counter-bond sends this to arbitration.",
              outcome: OUTCOME_WORD[proposal.outcome] ?? "?",
              bond: (Number(proposal.bond) / 1e6).toFixed(2),
              mins: Math.max(1, Math.ceil((windowEndsAt - nowSec) / 60)),
            })}
          </p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              run(
                "challenge",
                "optChallenge",
                [`sol:${key}`],
                "Challenged — the arbiter decides, loser pays winner",
              )
            }
            className="px-4 py-2 font-mono text-xs font-bold uppercase tracking-[0.1em] border border-warn/60 text-warn hover:bg-warn/10 disabled:opacity-50"
            data-testid="opt-challenge"
          >
            {busy === "challenge" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              t("optimistic.challengeCta", {
                defaultValue: "Challenge with matching bond",
              })
            )}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted leading-relaxed">
            {t("optimistic.finalizable", {
              defaultValue:
                "Assertion {{outcome}} survived its challenge window unchallenged. Anyone may finalize: the market settles and the bond returns.",
              outcome: OUTCOME_WORD[proposal.outcome] ?? "?",
            })}
          </p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              run(
                "finalize",
                "optFinalize",
                [`sol:${key}`],
                "Finalized — the assertion settled the market",
              )
            }
            className="px-4 py-2 font-mono text-xs font-bold uppercase tracking-[0.1em] border border-accent text-accent hover:bg-accent hover:text-canvas disabled:opacity-50"
            data-testid="opt-finalize"
          >
            {busy === "finalize" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              t("optimistic.finalizeCta", { defaultValue: "Finalize" })
            )}
          </button>
        </>
      )}
    </div>
  );
}
