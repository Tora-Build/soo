// Draft, fetch, judge, retry.
//
// The loop exists because the honest answer to "did the model get the response
// shape right?" is only knowable by fetching. So a proposal is never returned
// on the model's say-so: it is validated, and when it fails the failure is
// handed back as feedback and the model tries again, bounded. What comes out is
// only ever candidates this Worker itself fetched and parsed.

import { validateProposal } from "./validate.js";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const TARGET_CANDIDATES = 3;
export const MIN_CANDIDATES = 2;

/** More than this per attempt and one draft request could fan out into a lot of outbound fetches. */
const MAX_PROPOSALS_PER_ATTEMPT = 4;

/**
 * Runs the draft loop against an injected `model`.
 *
 * `model.propose({ question, feedback, count })` returns raw proposals; every
 * other argument exists so the whole path is testable with a stub. Returns the
 * validated candidates best first, plus the rejections, which the caller
 * surfaces when nothing survived.
 */
export async function draft(question, options = {}) {
  const {
    model,
    fetchImpl = fetch,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeoutMs,
    maxBytes,
  } = options;

  const accepted = [];
  const rejections = [];
  const seen = new Set();
  let attempts = 0;
  let modelError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts = attempt + 1;

    let proposals;
    try {
      proposals = await model.propose({
        question,
        // Feedback is cumulative: an endpoint rejected on attempt 1 must not
        // come back on attempt 3, and the model only knows that if it is told.
        feedback: rejections.slice(-8),
        count: TARGET_CANDIDATES,
      });
    } catch (e) {
      modelError = e;
      break;
    }

    const fresh = [];
    for (const p of Array.isArray(proposals) ? proposals : []) {
      const key = `${p?.url}|${p?.parsePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(p);
      if (fresh.length >= MAX_PROPOSALS_PER_ATTEMPT) break;
    }

    const results = await Promise.all(
      fresh.map((p) => validateProposal(p, { fetchImpl, timeoutMs, maxBytes })),
    );
    results.forEach((r, i) => {
      if (r.ok) accepted.push(r.candidate);
      else rejections.push(`${fresh[i]?.url ?? "(no url)"} ${fresh[i]?.parsePath ?? ""}: ${r.reason}`);
    });

    // Two survivors is a real choice for the creator; stop spending Gemini calls.
    if (accepted.length >= MIN_CANDIDATES) break;
  }

  if (accepted.length === 0 && modelError) throw modelError;

  // Best first. The model already orders its output, so a stable sort on
  // confidence keeps that order among equals.
  const candidates = accepted
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.confidence - a.c.confidence || a.i - b.i)
    .slice(0, TARGET_CANDIDATES)
    .map(({ c }) => c);

  return { candidates, attempts, rejections };
}
