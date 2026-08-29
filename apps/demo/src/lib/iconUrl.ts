/**
 * Creator-supplied icon URLs — validation and budget.
 *
 * A market's icon travels inside the on-chain question string, which the
 * program caps at 300 bytes for the WHOLE envelope. So a URL is not free:
 * every character spends the creator's question budget, and the failure mode
 * without a visible meter is a market that refuses to create at the last
 * signature. `iconUrlIssue` states the rule; `sqfByteLength` prices it.
 */

export const MAX_QUESTION_BYTES = 300;
/** The § envelope's own overhead plus a category — measured, not guessed. */
export const ENVELOPE_OVERHEAD_BYTES = 40;

/** Null when acceptable; otherwise the reason, phrased for a creator. */
export function iconUrlIssue(url: string): string | null {
  const text = url.trim();
  if (!text) return null; // empty is fine — the fallback chain handles it
  if (!/^https:\/\//i.test(text)) {
    return "Must be an https:// image link";
  }
  if (new TextEncoder().encode(text).length > 200) {
    return "Link is too long — icons share the market's 300-byte on-chain budget";
  }
  try {
    // A parse failure here is a typo, not an exotic URL.
    void new URL(text);
  } catch {
    return "Not a valid link";
  }
  return null;
}

/** Bytes the question + icon + category envelope will occupy on-chain. */
export function sqfByteLength(question: string, icon: string): number {
  const enc = new TextEncoder();
  return (
    enc.encode(question.trim()).length +
    (icon.trim() ? enc.encode(icon.trim()).length + 7 : 0) +
    ENVELOPE_OVERHEAD_BYTES
  );
}
