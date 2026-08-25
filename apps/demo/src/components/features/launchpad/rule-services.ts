// The two services that stand beside the Forge, and never in front of it.
//
// A market's `rule_hash` is written at creation and is immutable. Two failures
// follow from that, and each one has a service here:
//
//   1. The creator does not know WHICH endpoint answers their question. The
//      drafter (`VITE_AI_DRAFTER_URL`) proposes candidates from the question.
//   2. The rule fetches fine and Primus still cannot attest it — auth,
//      response size, TLS cipher, proxy behaviour. Only a real attestation
//      settles that, so the resolver (`VITE_RESOLVER_URL`) runs one.
//
// Both are ACCELERATORS. Either URL may be unset and either call may fail; in
// every such case the manual path is exactly what it was, and the form says
// why the button is unavailable rather than pretending it is broken.

import type { ComparatorId } from "./zk-rule";
import { COMPARATORS } from "./zk-rule";

const trimmedEnv = (value: unknown): string | null => {
  const text = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  return text.length > 0 ? text : null;
};

/** The AI drafting service. Unset on any deployment that has not run one. */
export const DRAFTER_URL = trimmedEnv(import.meta.env.VITE_AI_DRAFTER_URL);

/** The zk-resolver's `--serve` mode. Unset means no rule can be proven here. */
export const RESOLVER_URL = trimmedEnv(import.meta.env.VITE_RESOLVER_URL);

/** Optional shared token, matching the resolver's `RESOLVER_API_TOKEN`. */
const RESOLVER_TOKEN = trimmedEnv(import.meta.env.VITE_RESOLVER_TOKEN);

/**
 * A drafting run holds the browser open while a model is called and every
 * proposal it makes is fetched, so it is slow by construction — but never
 * unbounded. Without this a hung upstream leaves a spinner turning forever,
 * which reads as a broken page rather than a slow one.
 */
export const DRAFT_TIMEOUT_MS = 90_000;

/** The drafter's tightened wording of the question. Absent when it had nothing to add. */
export interface PolishSuggestion {
  polished: string;
  /** False when the model handed the question back unchanged. */
  changed: boolean;
  /** One sentence: what it tightened, or what the creator still has to decide. */
  notes: string;
  /** The category it filed the question under, or null if it named one this app has no shelf for. */
  category: string | null;
  /** YYYY-MM-DD the question itself named, or null when it named no date. */
  deadline: string | null;
}

/** What one drafting run produced: rules to pick from, and optionally better wording. */
export interface DraftResult {
  candidates: DraftCandidate[];
  polish: PolishSuggestion | null;
  /**
   * No public feed can settle this question, so it needs a human adjudicator.
   *
   * A distinct outcome from "drafting failed": nothing is wrong, and the
   * market is still creatable. Reported because the alternative the model
   * reaches for is a real endpoint about something else, which passes every
   * check and would settle the market on nothing.
   */
  needsAdjudicator: boolean;
}

/** A rule the drafter suggests, already shaped like the form's fields. */
export interface DraftCandidate {
  url: string;
  parsePath: string;
  comparator: ComparatorId;
  threshold: string;
  valueScale: number;
  /** What the drafter read at that path, so the suggestion is checkable. */
  reading: string | null;
  /** Why this endpoint answers the question. Prose, shown verbatim. */
  rationale: string;
  /** 0..1. Rendered as a percentage; never used as a gate. */
  confidence: number | null;
}

/**
 * Wire comparator -> the form's id, case-insensitively.
 *
 * The drafting service speaks the JSON convention ("gte") and this app speaks
 * the on-chain enum's ("Gte"). Compared exactly, every candidate the service
 * ever returned was dropped by the narrower below and the form reported "no
 * usable candidate" — a total failure of drafting that looked like the model
 * having nothing to say, because a discarded candidate leaves no trace.
 */
const COMPARATOR_BY_LOWER = new Map(
  COMPARATORS.map((c) => [c.id.toLowerCase(), c.id]),
);

const toComparator = (value: unknown): ComparatorId | null =>
  (typeof value === "string"
    ? (COMPARATOR_BY_LOWER.get(value.trim().toLowerCase()) ?? null)
    : null);

/**
 * Narrows one candidate off the wire, discarding anything unusable.
 *
 * The drafter is a model behind an HTTP hop; it can return a comparator that
 * is not one, a scale that is not a number, a threshold as a float. A
 * candidate that cannot fill the form is dropped rather than rendered, because
 * a suggestion that half-populates the fields is worse than one fewer option.
 */
export function parseCandidate(raw: unknown): DraftCandidate | null {
  if (raw === null || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const url = typeof c.url === "string" ? c.url.trim() : "";
  const parsePath = typeof c.parsePath === "string" ? c.parsePath.trim() : "";
  if (!/^https:\/\//i.test(url) || !parsePath.startsWith("$")) return null;
  const comparator = toComparator(c.comparator);
  if (comparator === null) return null;

  const threshold =
    typeof c.threshold === "string"
      ? c.threshold.trim()
      : typeof c.threshold === "number"
        ? String(c.threshold)
        : "";
  if (!/^\d+(\.\d+)?$/.test(threshold)) return null;

  const scale = Number(c.valueScale);
  const valueScale =
    Number.isInteger(scale) && scale >= 0 && scale <= 18 ? scale : 8;

  return {
    url,
    parsePath,
    comparator,
    threshold,
    valueScale,
    reading:
      typeof c.reading === "string" || typeof c.reading === "number"
        ? String(c.reading)
        : null,
    rationale: typeof c.rationale === "string" ? c.rationale : "",
    confidence:
      typeof c.confidence === "number" && Number.isFinite(c.confidence)
        ? Math.max(0, Math.min(1, c.confidence))
        : null,
  };
}

/** Narrows the wording suggestion; anything not usable reads as "no suggestion". */
function parsePolish(raw: unknown, question: string): PolishSuggestion | null {
  if (raw === null || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const polished = typeof p.polished === "string" ? p.polished.trim() : "";
  if (polished.length === 0 || polished.length > 300) return null;
  return {
    polished,
    // The service already decides this, but the form must not offer the
    // creator their own sentence back as an improvement under any circumstance.
    changed: polished !== question.trim(),
    notes: typeof p.notes === "string" ? p.notes.trim() : "",
    category: typeof p.category === "string" && p.category.trim() ? p.category.trim() : null,
    deadline:
      typeof p.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.deadline.trim())
        ? p.deadline.trim()
        : null,
  };
}

/**
 * Asks the drafter for rule candidates and a tightened question.
 *
 * A 422 means the run completed and nothing survived validation — the wording
 * suggestion still comes back with it, because a question no endpoint could
 * answer is most often a question that needs rewriting. Every other failure
 * throws, because the caller's correct response is the same either way: say
 * so, and leave the fields alone.
 */
export async function draftRules(
  question: string,
  signal?: AbortSignal,
): Promise<DraftResult> {
  if (!DRAFTER_URL) throw new Error("VITE_AI_DRAFTER_URL is not set");
  const res = await fetch(`${DRAFTER_URL}/draft`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  if (!res.ok) {
    const polish = parsePolish(body?.polish, question);
    if (res.status === 422 && body?.needsAdjudicator === true) {
      return { candidates: [], polish, needsAdjudicator: true };
    }
    if (res.status === 422 && polish?.changed) {
      return { candidates: [], polish, needsAdjudicator: false };
    }
    throw new Error(
      typeof body?.error === "string" ? body.error : `HTTP ${res.status}`,
    );
  }

  const raw = body?.candidates;
  if (!Array.isArray(raw)) throw new Error("no candidates in the response");
  const candidates = raw
    .map(parseCandidate)
    .filter((c): c is DraftCandidate => c !== null);
  if (candidates.length === 0) throw new Error("no usable candidate");
  return {
    candidates,
    polish: parsePolish(body?.polish, question),
    needsAdjudicator: false,
  };
}

/** A rule Primus signed a reading of. */
export interface ProofOk {
  ok: true;
  attestedValue: string;
  decimals: number;
  attestorAddress: string;
  elapsedMs: number;
  quotaRemaining?: number;
}

/** A rule Primus could not attest, and the stage that failed. */
export interface ProofFailure {
  ok: false;
  reason: string;
  detail: string;
}

export type ProofResult = ProofOk | ProofFailure;

/**
 * Runs one real Primus attestation of `(url, parsePath)` through the resolver.
 *
 * The resolver answers an unattestable rule with `200 { ok: false, reason }` —
 * that is an answer, not an error, and it is the single most valuable thing
 * this form can learn before a hash goes on chain. Only transport and
 * misconfiguration throw.
 *
 * Each call spends one unit of the deployment's Primus quota, which is why
 * nothing here fires on a timer or on keystrokes: it is a button, pressed once.
 */
export async function proveRule(
  url: string,
  parsePath: string,
  signal?: AbortSignal,
): Promise<ProofResult> {
  if (!RESOLVER_URL) throw new Error("VITE_RESOLVER_URL is not set");
  const res = await fetch(`${RESOLVER_URL}/attest-preview`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(RESOLVER_TOKEN ? { authorization: `Bearer ${RESOLVER_TOKEN}` } : {}),
    },
    body: JSON.stringify({ url, parsePath }),
    signal,
  });
  const body = (await res.json().catch(() => null)) as ProofResult | null;
  if (body && typeof body.ok === "boolean") return body;
  throw new Error(`HTTP ${res.status}`);
}

/**
 * A proof is only a proof of the rule it ran against.
 *
 * Edit the URL or the path after proving and the badge must go — otherwise the
 * creator commits an endpoint nobody attested while looking at a green tick
 * earned by a different one.
 */
export interface ProvenRule {
  url: string;
  parsePath: string;
  result: ProofOk;
}

export const proofCoversDraft = (
  proven: ProvenRule | null,
  url: string,
  parsePath: string,
): boolean =>
  proven !== null &&
  proven.url === url.trim() &&
  proven.parsePath === parsePath.trim();


/**
 * Hands the rule's preimage to the resolver so the market is WATCHED.
 *
 * The chain stores only `sha256(url ‖ parsePath)`; the plaintext exists in
 * exactly one place at creation time — this browser — and the resolver
 * cannot watch what it cannot name. The endpoint verifies the preimage
 * against the on-chain rule hash before accepting, so this is a
 * notification, not a trust grant. Failure is survivable (the market still
 * resolves at its deadline once someone registers it by hand), which is why
 * the caller treats it as fire-and-report rather than fire-and-die.
 */
export async function registerWithResolver(
  marketPda: string,
  url: string,
  parsePath: string,
): Promise<{ ok: boolean; detail?: string }> {
  if (!RESOLVER_URL) return { ok: false, detail: "VITE_RESOLVER_URL is not set" };
  try {
    const res = await fetch(`${RESOLVER_URL}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(RESOLVER_TOKEN ? { authorization: `Bearer ${RESOLVER_TOKEN}` } : {}),
      },
      body: JSON.stringify({ market: marketPda, url, parsePath }),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; detail?: string } | null;
    return { ok: body?.ok === true, detail: body?.detail };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
