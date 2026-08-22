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

const COMPARATOR_IDS = COMPARATORS.map((c) => c.id);

const isComparator = (value: unknown): value is ComparatorId =>
  typeof value === "string" && (COMPARATOR_IDS as string[]).includes(value);

/**
 * Narrows one candidate off the wire, discarding anything unusable.
 *
 * The drafter is a model behind an HTTP hop; it can return a comparator that
 * is not one, a scale that is not a number, a threshold as a float. A
 * candidate that cannot fill the form is dropped rather than rendered, because
 * a suggestion that half-populates the fields is worse than one fewer option.
 */
function parseCandidate(raw: unknown): DraftCandidate | null {
  if (raw === null || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const url = typeof c.url === "string" ? c.url.trim() : "";
  const parsePath = typeof c.parsePath === "string" ? c.parsePath.trim() : "";
  if (!/^https:\/\//i.test(url) || !parsePath.startsWith("$")) return null;
  if (!isComparator(c.comparator)) return null;

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
    comparator: c.comparator,
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

/**
 * Asks the drafter for rule candidates.
 *
 * Throws on every failure — unreachable, non-2xx, malformed — because the
 * caller's only correct response is the same one either way: say so, and leave
 * the fields alone.
 */
export async function draftRules(
  question: string,
  signal?: AbortSignal,
): Promise<DraftCandidate[]> {
  if (!DRAFTER_URL) throw new Error("VITE_AI_DRAFTER_URL is not set");
  const res = await fetch(`${DRAFTER_URL}/draft`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: unknown = await res.json();
  const raw = (body as { candidates?: unknown })?.candidates;
  if (!Array.isArray(raw)) throw new Error("no candidates in the response");
  const candidates = raw
    .map(parseCandidate)
    .filter((c): c is DraftCandidate => c !== null);
  if (candidates.length === 0) throw new Error("no usable candidate");
  return candidates;
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
