// The gate. Nothing leaves this Worker that has not come back through here.
//
// A market commits to `sha256(len‖url‖len‖parsePath)` at creation and the
// commitment is PERMANENT. A wrong URL or a path that names nothing is not a
// bug that surfaces at deploy time — it stays silent until settlement, when the
// market can no longer be fixed. So a proposal is a hypothesis, and this module
// is the experiment: fetch the endpoint, walk the path, read a finite number,
// or reject with a sentence the model can act on.
//
// Downstream the rule is attested by Primus zkTLS in proxy-TLS mode: public
// GET, no auth headers, small JSON response, one numeric field. Every rule
// below exists because a violation makes the rule unprovable, unparseable on
// chain, or ambiguous — never merely inelegant.

import { evaluateParsePath, fitsScale, fractionDigits, isDecimalString } from "./jsonpath.js";

export const COMPARATORS = ["gt", "gte", "lt", "lte", "eq"];

/** Primus reads the whole response inside the TLS session; a large body is not attestable. */
export const MAX_RESPONSE_BYTES = 32 * 1024;

/** A dead endpoint must fail fast — a draft request holds a browser open. */
export const DEFAULT_TIMEOUT_MS = 6_000;

/** The chain's fixed-point scale is a u8 in practice; beyond this it overflows what u128 can carry. */
export const MAX_VALUE_SCALE = 18;

/** Query parameters whose presence means the endpoint is gated by a key we must never ship. */
const SECRET_QUERY_KEYS = /^(api[-_]?key|apikey|key|token|access[-_]?token|auth|secret|appid|app[-_]?id)$/i;

class Rejection extends Error {}

/** A rejection carries the reason back to the model; a thrown Error anywhere else is a bug. */
function reject(reason) {
  throw new Rejection(reason);
}

/**
 * Static checks on the proposal itself — everything decidable without a fetch.
 *
 * Run first so an obviously unattestable proposal never costs a network round
 * trip, and so the feedback the model gets names the field it got wrong.
 */
export function checkShape(p) {
  if (!p || typeof p !== "object") reject("proposal is not an object");

  if (typeof p.url !== "string" || p.url.length === 0) reject("url is missing");
  let u;
  try {
    u = new URL(p.url);
  } catch {
    reject(`url ${JSON.stringify(p.url)} is not a valid absolute URL`);
  }
  if (u.protocol !== "https:") reject(`url ${p.url} is not https — zkTLS attests TLS sessions only`);
  if (u.username || u.password) reject(`url ${p.url} embeds credentials; the rule must need no auth`);
  for (const name of u.searchParams.keys()) {
    if (SECRET_QUERY_KEYS.test(name)) {
      reject(
        `url ${p.url} carries a "${name}" query parameter, so it is key-gated; ` +
          `propose an endpoint that is public and needs no API key`,
      );
    }
  }

  if (typeof p.parsePath !== "string") reject("parsePath is missing");

  if (!COMPARATORS.includes(p.comparator)) {
    reject(`comparator ${JSON.stringify(p.comparator)} is not one of ${COMPARATORS.join(", ")}`);
  }

  const threshold = typeof p.threshold === "number" ? String(p.threshold) : p.threshold;
  if (!isDecimalString(threshold)) {
    reject(`threshold ${JSON.stringify(p.threshold)} is not a plain decimal string like "90000"`);
  }

  const scale = typeof p.valueScale === "string" ? Number(p.valueScale) : p.valueScale;
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_VALUE_SCALE) {
    reject(`valueScale ${JSON.stringify(p.valueScale)} is not an integer in 0..${MAX_VALUE_SCALE}`);
  }
  if (!fitsScale(threshold.trim(), scale)) {
    reject(
      `threshold ${threshold} carries ${fractionDigits(threshold)} decimals, more than ` +
        `valueScale ${scale}; the program rejects excess precision rather than truncating`,
    );
  }

  if (typeof p.rationale !== "string" || p.rationale.trim().length < 10) {
    reject("rationale is missing — one sentence a human can check the question against");
  }

  return { ...p, url: u.toString(), threshold: threshold.trim(), valueScale: scale };
}

/**
 * Reads at most `limit` bytes of a response body.
 *
 * Bounded rather than `text()` because the size rule is a real defence: an
 * endpoint that streams megabytes would otherwise be downloaded in full just to
 * be rejected for being large.
 */
async function readBounded(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    return { overLimit: true, bytes: declared, text: "" };
  }
  const reader = response.body?.getReader();
  if (!reader) return { overLimit: false, bytes: 0, text: "" };

  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      return { overLimit: true, bytes, text: "" };
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return { overLimit: false, bytes, text: new TextDecoder().decode(joined) };
}

/**
 * Fetches the proposed endpoint exactly the way Primus will: plain GET, no
 * credentials, no auth headers.
 *
 * If this call needs anything the attestor cannot reproduce, the rule is not
 * provable and the candidate is dead here rather than at settlement.
 */
async function probe(url, { fetchImpl, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (e) {
    reject(`GET ${url} failed: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403 || res.headers.get("www-authenticate")) {
    reject(`GET ${url} returned HTTP ${res.status} — the endpoint requires authentication`);
  }
  if (!res.ok) {
    reject(`GET ${url} returned HTTP ${res.status}; the endpoint must answer 200 to a plain GET`);
  }

  const { overLimit, bytes, text } = await readBounded(res, maxBytes);
  if (overLimit) {
    reject(
      `GET ${url} returned ${bytes} bytes, over the ${maxBytes}-byte ceiling; ` +
        `zkTLS attestation needs a small JSON response`,
    );
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    reject(`GET ${url} did not return JSON (first bytes: ${text.slice(0, 80)})`);
  }
  return { body, bytes };
}

/**
 * The full gate: shape, then live fetch, then the number itself.
 *
 * Returns `{ ok: true, candidate }` with `reading` set to the value this Worker
 * actually observed, or `{ ok: false, reason }` where the reason is written for
 * the model to retry against. It never throws for a bad proposal — only a bug
 * in this module can throw.
 */
export async function validateProposal(proposal, options = {}) {
  const {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = MAX_RESPONSE_BYTES,
  } = options;

  try {
    const p = checkShape(proposal);
    const { body, bytes } = await probe(p.url, { fetchImpl, timeoutMs, maxBytes });

    let raw;
    try {
      raw = evaluateParsePath(body, p.parsePath);
    } catch (e) {
      reject(`${e.message} (response keys: ${Object.keys(body ?? {}).join(", ") || "none"})`);
    }

    if (raw === null || raw === undefined) {
      reject(`parsePath ${p.parsePath} resolves to ${raw} in the live response, not a number`);
    }
    if (typeof raw === "object") {
      reject(
        `parsePath ${p.parsePath} resolves to ${Array.isArray(raw) ? "an array" : "an object"}, ` +
          `not a single number; name the numeric leaf field itself`,
      );
    }
    if (typeof raw === "boolean") {
      reject(`parsePath ${p.parsePath} resolves to a boolean, not a number`);
    }

    const reading = String(raw).trim();
    if (!isDecimalString(reading) || !Number.isFinite(Number(reading))) {
      reject(
        `parsePath ${p.parsePath} resolves to ${JSON.stringify(raw)}, which is not a bare ` +
          `decimal number; the chain parses the attested value as fixed point`,
      );
    }

    // Attested precision VARIES between readings, so the scale has to hold more
    // than the one reading we happened to see. Excess precision is rejected on
    // chain, not truncated — a scale sized exactly to today's reading is a
    // market that fails to settle the day the feed prints one more digit.
    const seen = fractionDigits(reading);
    if (p.valueScale < seen) {
      reject(
        `valueScale ${p.valueScale} is below the ${seen} decimals the live reading ${reading} ` +
          `already carries; the program rejects excess precision rather than truncating`,
      );
    }
    if (p.valueScale < seen + 2 && p.valueScale < 8) {
      reject(
        `valueScale ${p.valueScale} leaves no headroom over the live reading ${reading}; ` +
          `attested precision varies between readings — use 8 for prices`,
      );
    }

    return {
      ok: true,
      candidate: {
        url: p.url,
        parsePath: p.parsePath,
        comparator: p.comparator,
        threshold: p.threshold,
        valueScale: p.valueScale,
        reading,
        rationale: p.rationale.trim(),
        confidence: clampConfidence(p.confidence),
      },
      bytes,
    };
  } catch (e) {
    if (e instanceof Rejection) return { ok: false, reason: e.message };
    throw e;
  }
}

/** The model's self-report, coerced into 0..1; absent or nonsense reads as 0.5. */
function clampConfidence(c) {
  const n = typeof c === "string" ? Number(c) : c;
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}
