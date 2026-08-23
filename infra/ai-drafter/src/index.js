// soo-ai-drafter — a question in, a VALIDATED resolution rule out.
//
//   POST /draft   { question }  -> { candidates: [ { url, parsePath, comparator,
//                                    threshold, valueScale, reading, rationale,
//                                    confidence } ],
//                                    polish?: { polished, changed, notes } }
//   GET  /health               -> { ok, geminiConfigured }
//
// The contract this Worker keeps: every candidate it returns was fetched and
// parsed to a finite number by this Worker, during this request. `reading` is
// that observed value. A market commits to (url, parsePath) permanently, so a
// plausible-looking rule that has never been fetched is worse than no rule.
//
// The browser calls this directly, so CORS is permissive and the Gemini key
// stays server-side as a secret — it is never in the bundle, in wrangler.toml,
// or in any response.

import { draft } from "./draft.js";
import { createGeminiModel } from "./gemini.js";
import { take } from "./ratelimit.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });

/** A question shorter than this cannot carry a threshold; longer than this is not a question. */
const MIN_QUESTION = 8;
const MAX_QUESTION = 600;

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx, {});
  },
};

/**
 * The router. `deps.model` is the seam: production leaves it unset and a Gemini
 * client is built from the secret, tests pass a stub and exercise every line
 * below without a key.
 */
export async function handle(request, env, _ctx, deps = {}) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  if (url.pathname === "/health") {
    return json({ ok: true, geminiConfigured: Boolean(env?.GEMINI_API_KEY) });
  }

  if (url.pathname !== "/draft") return json({ error: "not found" }, 404);
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const gate = take(ip, {
    max: Number(env?.RATE_LIMIT_MAX ?? 12),
    windowMs: Number(env?.RATE_LIMIT_WINDOW_SECONDS ?? 600) * 1000,
  });
  if (!gate.allowed) {
    return json({ error: "rate limited" }, 429, { "retry-after": String(gate.retryAfter) });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  const question = typeof payload?.question === "string" ? payload.question.trim() : "";
  if (question.length < MIN_QUESTION || question.length > MAX_QUESTION) {
    return json({ error: `question must be ${MIN_QUESTION}..${MAX_QUESTION} characters` }, 400);
  }

  let model = deps.model;
  if (!model) {
    if (!env?.GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY is not configured" }, 503);
    model = createGeminiModel({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL });
  }

  // Both calls go out together: the polish is a second opinion on the wording,
  // not a step the rules wait on, and serialising them would add its whole
  // latency to a request a browser is already holding open.
  //
  // `polish` is optional on the model seam so existing stubs keep working, and
  // a rejection is swallowed: a failed suggestion must never cost the creator
  // the candidates that came back in the same request.
  const polishPromise =
    typeof model.polish === "function"
      ? model.polish({ question }).catch(() => null)
      : Promise.resolve(null);

  let result;
  try {
    result = await draft(question, { model, fetchImpl: deps.fetchImpl ?? fetch });
  } catch (e) {
    void polishPromise;
    // The model failed outright. Say so plainly rather than returning an empty
    // list, which a caller could read as "no rule exists for this question".
    return json({ error: `drafting failed: ${e?.message ?? e}` }, 502);
  }

  const polish = await polishPromise;

  if (result.candidates.length === 0) {
    // Nothing was fetched successfully, so there is nothing honest to return —
    // but the wording suggestion still ships, because a question no endpoint
    // could answer is very often a question that needs rewriting.
    return json(
      {
        error: "no candidate validated against a live endpoint",
        attempts: result.attempts,
        rejections: result.rejections,
        ...(polish ? { polish } : {}),
      },
      422,
    );
  }

  return json({
    candidates: result.candidates,
    attempts: result.attempts,
    ...(polish ? { polish } : {}),
  });
}
