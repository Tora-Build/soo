// Two affordances beside the Automatic rule, and one sentence that matters
// more than either.
//
// Draft with AI turns the question into candidate endpoints. Prove with Primus
// runs a REAL attestation of the endpoint that is actually in the fields. The
// sentence is the third thing: a rule that has not been proven can still be
// launched — the founder may know something the tool does not — but never
// while the screen implies it is fine. `rule_hash` is written once and forever,
// and an unattestable rule is a market that can only ever be settled by hand.
//
// Both services are optional. With `VITE_AI_DRAFTER_URL` or
// `VITE_RESOLVER_URL` unset the button is disabled and says which variable is
// missing; the manual fields, the live preview and creation itself are
// untouched. This panel can never be the reason a market is not created.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  Loader2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { cn } from "../../../lib/utils";
import { COMPARATORS, type ZkRuleDraft } from "./zk-rule";
import {
  DRAFTER_URL,
  RESOLVER_URL,
  draftRules,
  proofCoversDraft,
  proveRule,
  type DraftCandidate,
  type ProofFailure,
  type ProvenRule,
} from "./rule-services";

interface Props {
  /** The market question, which is the whole input to the drafter. */
  question: string;
  draft: ZkRuleDraft;
  onDraftChange: (draft: ZkRuleDraft) => void;
  proven: ProvenRule | null;
  onProven: (proven: ProvenRule | null) => void;
}

const symbolOf = (id: string) =>
  COMPARATORS.find((c) => c.id === id)?.symbol ?? id;

/** Shortens an EVM address to something a human compares by eye. */
const shortAddress = (address: string) =>
  address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

export const RuleAssistant = ({
  question,
  draft,
  onDraftChange,
  proven,
  onProven,
}: Props) => {
  const { t } = useTranslation();

  const [candidates, setCandidates] = useState<DraftCandidate[] | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const [proving, setProving] = useState(false);
  const [failure, setFailure] = useState<ProofFailure | null>(null);
  const [proveError, setProveError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const url = draft.url.trim();
  const parsePath = draft.parsePath.trim();
  const ruleReady = /^https:\/\//i.test(url) && parsePath.startsWith("$");
  const isProven = proofCoversDraft(proven, url, parsePath);

  // A proof belongs to one exact (url, parsePath). The moment either moves,
  // every verdict on screen is about a rule that is no longer in the form.
  useEffect(() => {
    setFailure(null);
    setProveError(null);
    if (!proofCoversDraft(proven, url, parsePath)) onProven(null);
    // `proven`/`onProven` are the parent's state and setter; depending on them
    // would clear a proof on the render that just recorded it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, parsePath]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const handleDraft = async () => {
    setDrafting(true);
    setDraftError(null);
    try {
      setCandidates(await draftRules(question.trim()));
    } catch (e) {
      setCandidates(null);
      setDraftError((e as Error).message || "unreachable");
    } finally {
      setDrafting(false);
    }
  };

  const applyCandidate = (candidate: DraftCandidate) => {
    onDraftChange({
      ...draft,
      // A drafted endpoint is by definition not one of the presets, so the
      // form switches to custom and the url/path become editable.
      presetId: "custom",
      url: candidate.url,
      parsePath: candidate.parsePath,
      comparator: candidate.comparator,
      threshold: candidate.threshold,
      valueScale: candidate.valueScale,
    });
    setCandidates(null);
  };

  const handleProve = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setProving(true);
    setFailure(null);
    setProveError(null);
    try {
      const result = await proveRule(url, parsePath, controller.signal);
      if (controller.signal.aborted) return;
      if (result.ok) {
        onProven({ url, parsePath, result });
      } else {
        onProven(null);
        setFailure(result);
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      onProven(null);
      setProveError((e as Error).message || "unreachable");
    } finally {
      if (!controller.signal.aborted) setProving(false);
    }
  };

  const canDraft = Boolean(DRAFTER_URL) && question.trim().length >= 10;
  const canProve = Boolean(RESOLVER_URL) && ruleReady;

  return (
    <div className="space-y-2" data-testid="launchpad-rule-assistant">
      <div className="grid grid-cols-2 gap-2">
        <button
          data-testid="launchpad-zk-draft"
          onClick={handleDraft}
          disabled={!canDraft || drafting}
          className={cn(
            "py-2 px-3 text-xs font-bold border border-rule transition-all",
            "flex items-center justify-center gap-1.5",
            "bg-raised text-muted hover:bg-inset hover:text-ink",
            "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-raised",
          )}
        >
          {drafting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Sparkles className="w-3.5 h-3.5" />
          )}
          {t("launchpad.zk.assist.draftButton")}
        </button>

        <button
          data-testid="launchpad-zk-prove"
          onClick={handleProve}
          disabled={!canProve || proving}
          className={cn(
            "py-2 px-3 text-xs font-bold border transition-all",
            "flex items-center justify-center gap-1.5",
            isProven
              ? "border-transparent bg-accent-muted text-accent"
              : "border-rule bg-raised text-muted hover:bg-inset hover:text-ink",
            "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-raised",
          )}
        >
          {proving ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <ShieldCheck className="w-3.5 h-3.5" />
          )}
          {proving
            ? t("launchpad.zk.assist.proving")
            : t("launchpad.zk.assist.proveButton")}
        </button>
      </div>

      {/* Why a button is unavailable, in the words of the thing that is
          missing. An accelerator that is simply greyed out reads as broken. */}
      {(!DRAFTER_URL || !RESOLVER_URL) && (
        <p
          data-testid="launchpad-zk-assist-unconfigured"
          className="text-xs text-faint leading-relaxed"
        >
          {!DRAFTER_URL && t("launchpad.zk.assist.noDrafter")}
          {!DRAFTER_URL && !RESOLVER_URL && " "}
          {!RESOLVER_URL && t("launchpad.zk.assist.noResolver")}
        </p>
      )}

      {DRAFTER_URL && question.trim().length < 10 && (
        <p className="text-xs text-faint">
          {t("launchpad.zk.assist.needQuestion")}
        </p>
      )}

      {draftError && (
        <p
          data-testid="launchpad-zk-draft-error"
          className="text-xs text-warn flex items-start gap-1.5"
        >
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          {t("launchpad.zk.assist.draftFailed", { error: draftError })}
        </p>
      )}

      {candidates && (
        <div className="space-y-1.5" data-testid="launchpad-zk-candidates">
          {candidates.map((candidate, i) => (
            <button
              key={`${candidate.url}${candidate.parsePath}`}
              data-testid={`launchpad-zk-candidate-${i}`}
              onClick={() => applyCandidate(candidate)}
              className="w-full border border-rule bg-canvas px-3 py-2 text-left transition-all hover:border-accent"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-xs text-ink break-all">
                  {candidate.url}
                  <span className="text-muted"> · {candidate.parsePath}</span>
                </span>
                {candidate.confidence !== null && (
                  <span className="font-mono text-xs text-faint tabular-nums shrink-0">
                    {Math.round(candidate.confidence * 100)}%
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-baseline gap-2 text-xs">
                <span className="font-mono text-accent tabular-nums">
                  {symbolOf(candidate.comparator)} {candidate.threshold}
                </span>
                {candidate.reading !== null && (
                  <span className="text-muted">
                    {t("launchpad.zk.assist.reads", {
                      reading: candidate.reading,
                    })}
                  </span>
                )}
              </div>
              {candidate.rationale && (
                <p className="mt-1 text-xs text-faint leading-snug">
                  {candidate.rationale}
                </p>
              )}
            </button>
          ))}
          <p className="text-xs text-faint">
            {t("launchpad.zk.assist.candidatesHint")}
          </p>
        </div>
      )}

      {isProven && proven && (
        <div
          data-testid="launchpad-zk-proven"
          className="border border-rule bg-canvas px-3 py-2 space-y-1"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-accent flex items-center gap-1.5">
              <Check className="w-3 h-3 shrink-0" />
              {t("launchpad.zk.assist.provenLabel")}
            </span>
            <span
              data-testid="launchpad-zk-proven-value"
              className="font-mono text-sm font-bold text-ink tabular-nums"
            >
              {proven.result.attestedValue}
            </span>
          </div>
          <p className="font-mono text-xs text-faint break-all">
            {t("launchpad.zk.assist.attestor", {
              address: shortAddress(proven.result.attestorAddress),
            })}
          </p>
          <p className="text-xs text-faint">
            {t("launchpad.zk.assist.provenDetail", {
              decimals: proven.result.decimals,
              seconds: (proven.result.elapsedMs / 1000).toFixed(1),
            })}
          </p>
        </div>
      )}

      {/* A refusal is the endpoint's most useful answer, so it is quoted in
          full: the stage that failed, then what the resolver saw. */}
      {failure && (
        <div
          data-testid="launchpad-zk-proof-failed"
          className="border border-rule bg-canvas px-3 py-2 space-y-1"
        >
          <p className="text-xs text-warn flex items-start gap-1.5">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
            {t(`launchpad.zk.assist.reasons.${failure.reason}`, {
              defaultValue: t("launchpad.zk.assist.reasons.unknown"),
            })}
          </p>
          <p className="font-mono text-xs text-faint break-words leading-snug">
            {failure.detail}
          </p>
        </div>
      )}

      {proveError && (
        <p
          data-testid="launchpad-zk-prove-error"
          className="text-xs text-warn flex items-start gap-1.5"
        >
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          {t("launchpad.zk.assist.proveFailed", { error: proveError })}
        </p>
      )}

      {/* The gate that matters. Never blocks; never stays quiet either. */}
      {!isProven && (
        <p
          data-testid="launchpad-zk-unproven"
          className="text-xs text-warn leading-relaxed flex items-start gap-1.5"
        >
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{t("launchpad.zk.assist.unprovenWarning")}</span>
        </p>
      )}
    </div>
  );
};
