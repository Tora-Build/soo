// Per-IP budget, in memory.
//
// The thing being protected is the Gemini key: one /draft is up to three model
// calls, and an unmetered public endpoint is a bill. This limiter lives in the
// isolate, so it is BEST EFFORT — Cloudflare may run several isolates and each
// keeps its own counters, and a fresh isolate starts empty. It stops casual
// draining, not a determined distributed attacker. Swap the map for a KV or
// Durable Object counter if the ceiling ever has to be exact.

const WINDOWS = new Map();

/** Entries outlive their window otherwise, and the map is the isolate's only memory. */
function sweep(now) {
  for (const [k, w] of WINDOWS) if (w.resetAt <= now) WINDOWS.delete(k);
}

/**
 * Consumes one unit for `key`. Returns `{ allowed, remaining, retryAfter }`.
 *
 * Fixed window rather than a token bucket: the counters are per-isolate and
 * short-lived, so precision here would be false precision.
 */
export function take(key, { max, windowMs, now = Date.now() }) {
  if (WINDOWS.size > 10_000) sweep(now);

  let w = WINDOWS.get(key);
  if (!w || w.resetAt <= now) {
    w = { count: 0, resetAt: now + windowMs };
    WINDOWS.set(key, w);
  }
  if (w.count >= max) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((w.resetAt - now) / 1000) };
  }
  w.count += 1;
  return { allowed: true, remaining: max - w.count, retryAfter: 0 };
}

/** Exposed so tests start from a known state; production never calls it. */
export function reset() {
  WINDOWS.clear();
}
