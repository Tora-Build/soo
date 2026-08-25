// The two steps of the Automatic rule, placed where each one acts.
//
// Step 1 turns the question into candidate endpoints — and, in the same call,
// offers tighter wording for the question itself, because question and rule are
// committed together and a precise rule under a vague question is still a
// broken market. It sits at the TOP of the panel, above the fields it fills.
//
// Step 2 runs a REAL attestation of the endpoint now in the fields, and sits
// below them, under the thing it judges. They were previously one pair of
// equal-looking buttons after everything, which invited pressing the second
// first — an action that can only fail, since there is nothing yet to prove.
//
// The warning is the third thing: a rule that has not been proven can still be
// launched — the founder may know something the tool does not — but never
// while the screen implies it is fine. `rule_hash` is written once and forever,
// and an unattestable rule is a market that can only ever be settled by hand.
// It appears once a rule exists to be judged, and not before: shown against
// empty fields it is not a warning about anything, and a warning that is always
// on is one nobody reads when it starts being true.
//
// Both services are optional. With `VITE_AI_DRAFTER_URL` or `VITE_RESOLVER_URL`
// unset the button is disabled and says which variable is missing; the manual
// fields, the live preview and creation itself are untouched. Neither of these
// can ever be the reason a market is not created.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  Loader2,
  ShieldCheck,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { cn } from "../../../lib/utils";
import { normalizeCategory } from "../../../lib/categories";
import { COMPARATORS, type ZkRuleDraft } from "./zk-rule";
import {
  DRAFTER_URL,
  DRAFT_TIMEOUT_MS,
  RESOLVER_URL,
  draftRules,
  proofCoversDraft,
  proveRule,
  type DraftCandidate,
  type PolishSuggestion,
  type ProofFailure,
  type ProvenRule,
} from "./rule-services";

const symbolOf = (id: string) =>
  COMPARATORS.find((c) => c.id === id)?.symbol ?? id;

/** The source a candidate reads from — the part a creator actually compares. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Shortens an EVM address to something a human compares by eye. */
const shortAddress = (address: string) =>
  address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

interface DrafterProps {
  /** The market question, which is the whole input to the drafter. */
  question: string;
  /** Applies the drafter's tightened wording. The creator's choice, never automatic. */
  onQuestionChange: (question: string) => void;
  draft: ZkRuleDraft;
  onDraftChange: (draft: ZkRuleDraft) => void;
  /**
   * Applies the category the drafter inferred.
   *
   * Applied without asking, unlike the wording: the category is a shelf the
   * market is filed on, not words anyone is held to, and creators pick it
   * wrongly often enough that a grid of icons was costing a screenful to get
   * a worse answer. It stays overridable under Advanced.
   */
  onCategoryChange: (category: string) => void;
  /**
   * Sets the market deadline when the question named a date.
   *
   * Only ever called with a date the creator wrote themselves — the service
   * returns nothing here when the question gave none, rather than choosing one.
   */
  onDeadlineChange: (isoDate: string) => void;
}

/** Step 1 — question in, candidate rules out. Sits directly under the question. */
export const RuleDrafter = ({
  question,
  onQuestionChange,
  draft,
  onDraftChange,
  onCategoryChange,
  onDeadlineChange,
}: DrafterProps) => {
  const { t } = useTranslation();

  const [candidates, setCandidates] = useState<DraftCandidate[] | null>(null);
  // Which candidate is in the fields. The list used to be discarded on pick,
  // so the one thing the screen never showed was the choice that had been made.
  const [chosen, setChosen] = useState<number | null>(null);
  const [polish, setPolish] = useState<PolishSuggestion | null>(null);
  // The wording as the creator typed it, kept so the auto-applied rephrase
  // has a one-click way back.
  const [preRephrase, setPreRephrase] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [needsAdjudicator, setNeedsAdjudicator] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // Distinguishes the creator pressing Cancel from the timeout firing. Both
  // abort the same controller, but only one of them is an error worth showing.
  const cancelledRef = useRef(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  // A drafting run calls a model and then fetches every endpoint it proposed,
  // so tens of seconds is normal. A bare spinner over that long reads as a
  // hung page, so the seconds are on screen and the run can be abandoned.
  useEffect(() => {
    if (!drafting) return;
    setElapsed(0);
    const started = Date.now();
    const id = window.setInterval(
      () => setElapsed(Math.round((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [drafting]);

  const cancel = () => {
    cancelledRef.current = true;
    abortRef.current?.abort();
  };

  const handleDraft = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    cancelledRef.current = false;
    const timeout = window.setTimeout(() => controller.abort(), DRAFT_TIMEOUT_MS);

    setDrafting(true);
    setDraftError(null);
    setCandidates(null);
    setPolish(null);
    setNeedsAdjudicator(false);
    try {
      const original = question.trim();
      const result = await draftRules(original, controller.signal);
      setCandidates(result.candidates.length > 0 ? result.candidates : null);
      // The rephrase is applied, not offered — a creator who asked the AI to
      // draft wants the drafted sentence in the box, with a way back, not a
      // second decision. Only a suggestion that actually differs shows at all.
      if (result.polish?.changed) {
        setPolish(result.polish);
        setPreRephrase(original);
        onQuestionChange(result.polish.polished);
      } else {
        setPolish(null);
        setPreRephrase(null);
      }
      // The model names categories freely ("Crypto", "finance"); the shelves
      // are a fixed lowercase set, so an unnormalised name selects nothing.
      if (result.polish?.category)
        onCategoryChange(normalizeCategory(result.polish.category));
      if (result.polish?.deadline) onDeadlineChange(result.polish.deadline);
      setChosen(null);
      setNeedsAdjudicator(result.needsAdjudicator);
      if (result.candidates.length === 0 && !result.needsAdjudicator) {
        setDraftError(t("launchpad.zk.assist.noneValidated"));
      }
    } catch (e) {
      setCandidates(null);
      if (controller.signal.aborted) {
        // A cancelled run is a decision, not a failure, and says nothing.
        if (!cancelledRef.current) {
          setDraftError(
            t("launchpad.zk.assist.timedOut", {
              seconds: Math.round(DRAFT_TIMEOUT_MS / 1000),
            }),
          );
        }
      } else {
        setDraftError((e as Error).message || "unreachable");
      }
    } finally {
      window.clearTimeout(timeout);
      setDrafting(false);
    }
  };

  const applyCandidate = (candidate: DraftCandidate, index: number) => {
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
    setChosen(index);
  };

  /** Puts the creator's own wording back. The rule fields are untouched. */
  const revertPolish = () => {
    if (preRephrase !== null) onQuestionChange(preRephrase);
    setPolish(null);
    setPreRephrase(null);
  };

  const canDraft = Boolean(DRAFTER_URL) && question.trim().length >= 10;

  return (
    <div className="space-y-2" data-testid="launchpad-rule-drafter">
      <button
        data-testid="launchpad-zk-draft"
        onClick={handleDraft}
        disabled={!canDraft || drafting}
        className={cn(
          "w-full py-2.5 px-3 text-sm font-bold border border-rule transition-all",
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
        {drafting
          ? t("launchpad.zk.assist.drafting", { seconds: elapsed })
          : t("launchpad.zk.assist.draftButton")}
      </button>

      {/* A long wait needs to say what it is waiting ON, or it reads as a
          hang. It also needs an exit that is not reloading the page. */}
      {drafting && (
        <div
          data-testid="launchpad-zk-drafting"
          className="flex items-start justify-between gap-2"
        >
          <p className="text-sm text-faint leading-relaxed">
            {t("launchpad.zk.assist.draftingDetail")}
          </p>
          <button
            data-testid="launchpad-zk-draft-cancel"
            onClick={cancel}
            className="shrink-0 flex items-center gap-1 text-xs text-muted hover:text-ink transition-colors"
          >
            <X className="w-3 h-3" />
            {t("launchpad.zk.assist.cancel")}
          </button>
        </div>
      )}

      {!DRAFTER_URL && (
        <p
          data-testid="launchpad-zk-assist-unconfigured"
          className="text-sm text-faint leading-relaxed"
        >
          {t("launchpad.zk.assist.noDrafter")}
        </p>
      )}

      {DRAFTER_URL && !drafting && question.trim().length < 10 && (
        <p className="text-sm text-faint">
          {t("launchpad.zk.assist.needQuestion")}
        </p>
      )}

      {draftError && (
        <p
          data-testid="launchpad-zk-draft-error"
          className="text-sm text-warn flex items-start gap-1.5"
        >
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          {t("launchpad.zk.assist.draftFailed", { error: draftError })}
        </p>
      )}

      {/* Not an error: the question is fine, it just is not one a machine can
          settle. Said plainly, because the model's own alternative is a real
          endpoint about something else. */}
      {needsAdjudicator && (
        <div
          data-testid="launchpad-zk-needs-adjudicator"
          className="border border-rule bg-canvas px-3 py-2 space-y-1"
        >
          <p className="text-sm text-ink leading-relaxed">
            {t("launchpad.zk.assist.needsAdjudicator")}
          </p>
          <p className="text-sm text-faint leading-relaxed">
            {t("launchpad.zk.assist.needsAdjudicatorDetail")}
          </p>
        </div>
      )}

      {/* The rephrase is already in the question box; this strip says so and
          holds the way back. The question is committed on-chain and disputes
          are settled by reading it, so the creator keeps the last word. */}
      {polish && (
        <div
          data-testid="launchpad-zk-polish"
          className="border border-rule bg-canvas px-3 py-2 space-y-1.5"
        >
          <p className="text-sm text-muted flex items-center gap-1.5">
            <Wand2 className="w-3 h-3 shrink-0" />
            {t("launchpad.zk.assist.polishApplied", {
              defaultValue: "Question rephrased by the drafter",
            })}
          </p>
          {polish.notes && (
            <p className="text-sm text-faint leading-snug">{polish.notes}</p>
          )}
          {preRephrase !== null && (
            <p className="text-sm text-faint leading-snug line-through decoration-rule">
              {preRephrase}
            </p>
          )}
          <div className="flex items-center gap-2 pt-0.5">
            <button
              data-testid="launchpad-zk-polish-revert"
              onClick={revertPolish}
              className="px-2 py-1 text-xs font-bold border border-rule bg-raised text-ink hover:border-accent transition-all"
            >
              {t("launchpad.zk.assist.polishKeep")}
            </button>
            <button
              data-testid="launchpad-zk-polish-dismiss"
              onClick={() => {
                setPolish(null);
                setPreRephrase(null);
              }}
              className="px-2 py-1 text-xs text-muted hover:text-ink transition-colors"
            >
              {t("launchpad.zk.assist.polishDismiss", { defaultValue: "OK" })}
            </button>
          </div>
        </div>
      )}

      {candidates && (
        <div className="space-y-2" data-testid="launchpad-zk-candidates">
          <p className="text-sm text-muted">
            {chosen === null
              ? t("launchpad.zk.assist.pickOne", { count: candidates.length })
              : t("launchpad.zk.assist.picked")}
          </p>

          {candidates.map((candidate, i) => {
            const selected = chosen === i;
            return (
              <button
                key={`${candidate.url}${candidate.parsePath}`}
                data-testid={`launchpad-zk-candidate-${i}`}
                aria-pressed={selected}
                onClick={() => applyCandidate(candidate, i)}
                className={cn(
                  "w-full border px-3 py-2.5 text-left transition-all",
                  selected
                    ? "border-accent bg-accent-muted"
                    : "border-rule bg-canvas hover:border-accent",
                )}
              >
                <div className="flex items-start gap-2">
                  {/* A filled mark is the whole affordance: which one is in the
                      fields has to be legible without reading the fields. */}
                  <span
                    className={cn(
                      "mt-0.5 w-4 h-4 shrink-0 border flex items-center justify-center",
                      selected ? "border-accent bg-accent" : "border-rule",
                    )}
                  >
                    {selected && <Check className="w-3 h-3 text-canvas" />}
                  </span>

                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className={cn(
                          "text-sm font-semibold truncate",
                          selected ? "text-accent" : "text-ink",
                        )}
                      >
                        {hostOf(candidate.url)}
                      </span>
                      <span className="font-mono text-sm tabular-nums shrink-0 text-ink">
                        {symbolOf(candidate.comparator)} {candidate.threshold}
                      </span>
                    </div>

                    {candidate.reading !== null && (
                      <p className="text-sm text-muted">
                        {t("launchpad.zk.assist.reads", {
                          reading: candidate.reading,
                        })}
                      </p>
                    )}

                    <p className="font-mono text-xs text-faint break-all">
                      {candidate.url}
                      <span className="text-muted"> · {candidate.parsePath}</span>
                    </p>
                  </div>
                </div>
              </button>
            );
          })}

          <p className="text-sm text-faint leading-relaxed">
            {t("launchpad.zk.assist.orOwn")}
          </p>
        </div>
      )}

    </div>
  );
};

interface ProverProps {
  draft: ZkRuleDraft;
  proven: ProvenRule | null;
  onProven: (proven: ProvenRule | null) => void;
}

/** Step 2 — one real attestation of the rule now in the fields, and the verdict. */
export const RuleProver = ({ draft, proven, onProven }: ProverProps) => {
  const { t } = useTranslation();

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

  const canProve = Boolean(RESOLVER_URL) && ruleReady;

  return (
    <div className="space-y-2" data-testid="launchpad-rule-prover">
      <button
        data-testid="launchpad-zk-prove"
        onClick={handleProve}
        disabled={!canProve || proving}
        className={cn(
          "w-full py-2.5 px-3 text-sm font-bold border transition-all",
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

      {/* Why the button is unavailable, in the words of the thing that is
          missing. An accelerator that is simply greyed out reads as broken. */}
      {!RESOLVER_URL && (
        <p className="text-sm text-faint leading-relaxed">
          {t("launchpad.zk.assist.noResolver")}
        </p>
      )}

      {RESOLVER_URL && !ruleReady && (
        <p className="text-sm text-faint">{t("launchpad.zk.assist.needRule")}</p>
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
          <p className="text-sm text-faint">
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
          <p className="text-sm text-warn flex items-start gap-1.5">
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
          className="text-sm text-warn flex items-start gap-1.5"
        >
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          {t("launchpad.zk.assist.proveFailed", { error: proveError })}
        </p>
      )}

      {/* No unproven warning here. The form opens with a preset rule already in
          the fields, so a warning gated on "a rule exists" fired before the
          creator had done anything — and it repeated the one beside the launch
          button, which is where the decision is actually made. One warning, at
          the moment it can still change what happens. */}
    </div>
  );
};
