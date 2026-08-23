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
 * Identity of a proposal, for deduplication.
 *
 * Deliberately IGNORES the query string. A model asked for distinct sources
 * will otherwise satisfy the letter of the instruction by appending a cosmetic
 * parameter — `?ref=oracle`, `&fmt=json` — producing three candidates that are
 * one endpoint wearing three hats. Keyed on the full URL those look distinct;
 * keyed on host+path+field they collapse, which is what they are.
 *
 * The cost is that two rules differing only in a MEANINGFUL parameter (say
 * `units=km` vs `units=miles`) also collapse. That is the right trade: they
 * read the same feed, so they fail together, and offering both as "different
 * sources" is exactly the false choice this is meant to remove.
 */
function sourceKey(proposal) {
  const path = proposal?.parsePath ?? "";
  try {
    const u = new URL(proposal?.url);
    return `${u.host}${u.pathname.replace(/\/+$/, "")}|${path}`.toLowerCase();
  } catch {
    return `${proposal?.url}|${path}`.toLowerCase();
  }
}

/** The host a candidate reads from; candidates sharing one share an outage. */
function hostOf(candidate) {
  try {
    return new URL(candidate.url).host.toLowerCase();
  } catch {
    return candidate.url;
  }
}

/**
 * Ranks best-first while spreading across hosts.
 *
 * Confidence alone tends to return three readings of one feed, because the
 * model is most confident about the source it recalls best. A source outage
 * then kills every option at once, which is the failure the candidate list
 * exists to protect against. So: one candidate per host first, in confidence
 * order, then backfill with the remainder if there were not enough hosts.
 */
function rankByConfidenceAcrossHosts(accepted, limit) {
  const byConfidence = accepted
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.confidence - a.c.confidence || a.i - b.i)
    .map(({ c }) => c);

  const seenHosts = new Set();
  const firstPerHost = [];
  const rest = [];
  for (const c of byConfidence) {
    const host = hostOf(c);
    if (seenHosts.has(host)) rest.push(c);
    else {
      seenHosts.add(host);
      firstPerHost.push(c);
    }
  }
  return [...firstPerHost, ...rest].slice(0, limit);
}

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
      // A mangled answer is worth asking again for; a refused request is not,
      // and retrying it would spend the remaining daily quota learning nothing.
      if (e?.retryable) continue;
      break;
    }

    const fresh = [];
    for (const p of Array.isArray(proposals) ? proposals : []) {
      const key = sourceKey(p);
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

  const candidates = rankByConfidenceAcrossHosts(accepted, TARGET_CANDIDATES);

  return { candidates, attempts, rejections };
}
