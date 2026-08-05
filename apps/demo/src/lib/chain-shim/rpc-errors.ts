// Telling "the chain said no" apart from "the chain did not answer".
//
// ## Why this matters
//
// Most shim reads degrade to a harmless empty value when they fail, which is
// right for depth or order lists: a market with no book really does have no
// orders, and stalling the panel on a thrown promise would be worse.
//
// `isGraduated` is not like that. It is a CLAIM, and it decides routing — a
// market that reads as not-graduated has no orderbook tab at all. So when the
// validator was down, every read failed, the catch returned `false`, and the
// orderbook silently vanished. Nothing on screen said the chain was gone; the
// app looked like it was working and quietly reported a market as still
// bonding when in fact nothing had been asked.
//
// A missing account and an unreachable RPC are different facts and must not
// collapse to the same answer. This classifies them.

/** Error text patterns that mean the request never reached a working node. */
const TRANSPORT_PATTERNS = [
  /fetch failed/i,
  /failed to fetch/i,
  /econnrefused/i,
  /enotfound/i,
  /etimedout/i,
  /econnreset/i,
  /socket hang up/i,
  /network ?error/i,
  /request timed out/i,
  /service unavailable/i,
  /502|503|504/,
];

function textOf(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    // Fetch failures commonly hide the real reason on `cause`.
    const cause = (err as { cause?: unknown }).cause;
    return `${err.message} ${cause ? textOf(cause) : ""}`;
  }
  if (typeof err === "object") {
    const o = err as { message?: unknown; code?: unknown; cause?: unknown };
    return [o.message, o.code, o.cause ? textOf(o.cause) : ""]
      .filter(Boolean)
      .join(" ");
  }
  return String(err);
}

/**
 * True when the failure means we never got an answer.
 *
 * Deliberately conservative: an unrecognised error is NOT reported as a
 * transport failure, because treating a genuine program error as "chain
 * unreachable" would hide a real bug behind an infrastructure message.
 */
export function isTransportFailure(err: unknown): boolean {
  const text = textOf(err);
  if (!text) return false;
  return TRANSPORT_PATTERNS.some((p) => p.test(text));
}

/**
 * Re-throw when the chain never answered; otherwise hand back `fallback`.
 *
 * Use for reads whose fallback is a claim rather than an absence. A thrown
 * error surfaces as an error state the user can see, instead of a confident
 * wrong answer they cannot.
 */
export function fallbackUnlessUnreachable<T>(err: unknown, fallback: T): T {
  if (isTransportFailure(err)) throw err;
  return fallback;
}
