// The model seam.
//
// `draft()` depends on the SHAPE below and nothing else: an object with
// `propose({ question, feedback, count })` returning an array of raw proposals.
// Gemini is one implementation; the tests supply another. That is what lets the
// entire validation and retry path be exercised with no API key, which matters
// because the validator — not the model — is the part that must be right.

import { catalogLines } from "./catalog.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * A non-reasoning model, chosen deliberately.
 *
 * Drafting a rule is recall and formatting: name an endpoint you have seen,
 * name the field, emit JSON. Measured on the same prompt, a reasoning Flash
 * spent 7,865 thinking tokens and still hit the output ceiling mid-object,
 * while this one answered in 388 with none — and the answers are judged by
 * FETCHING them, so deliberation the validator immediately overrules is pure
 * cost. Override with the GEMINI_MODEL binding.
 */
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";

/**
 * The key binding may hold several keys, comma or whitespace separated.
 *
 * The free tier is capped per PROJECT per day, so a second key from a second
 * project is the only way to raise the ceiling without billing — and the cap
 * is low enough that one demo session can reach it.
 */
export function splitKeys(value) {
  return String(value ?? "")
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * The rule the model is drafting is a permanent on-chain commitment, so the
 * prompt spends its whole budget on the two failure modes that survive review:
 * an endpoint that cannot be attested, and a path that does not exist in the
 * real response shape.
 */
export function buildPrompt({ question, feedback, count }) {
  const lines = [
    "You draft resolution rules for prediction markets. A rule reads ONE number from a public",
    "HTTPS JSON endpoint and compares it to a threshold. The rule is committed on chain",
    "permanently at market creation and can never be corrected, so a wrong URL or a path that",
    "does not exist stays silent until settlement and then breaks the market.",
    "",
    "The rule is later proven with Primus zkTLS in proxy-TLS mode. That constrains it absolutely:",
    "  - the endpoint MUST be public: no API key, no token, no auth header, no signed query",
    "  - the request MUST be a plain GET with no body",
    "  - the response MUST be small JSON (a few kilobytes at most), not a paginated list",
    "  - the value MUST be a bare number, or a string holding only a number (\"119042.35\")",
    "Anything needing a key, a POST, pagination, or a value that is not a bare number is unusable.",
    "",
    "These endpoints have been fetched and parsed successfully by this service. Prefer them when",
    "one genuinely answers the question — including with different parameters, ids or symbols in",
    "the same shape. They are a starting point, NOT a restriction: if none fits, propose your own.",
    ...catalogLines(),
    "",
    "Otherwise prefer well-known, stable, long-lived public endpoints that you are confident about",
    "— the kind whose response shape you have actually seen. A famous endpoint you can recall",
    "exactly beats an obscure one you are guessing at. Do not invent hostnames or paths.",
    "",
    "Write parsePath as JSONPath naming exactly one leaf field, exactly as it appears in the real",
    "response, e.g. $.data.amount or $.market_data.current_price.usd. No wildcards, no filters,",
    "no recursive descent, no array slices.",
    "",
    "Take the threshold from the question's own wording; do not round it or invent your own.",
    "Set comparator so that the rule resolves YES exactly when the question is true.",
    "",
    "valueScale is the number of decimals of headroom the on-chain fixed-point value carries.",
    "Give your best estimate — 8 suits prices and rates — and do not labour over it: it is raised",
    "automatically to fit the decimals the live response actually returns, so it is never the",
    "reason a good endpoint is rejected. Choosing the ENDPOINT and the PATH is the work.",
    "",
    `Question: ${question}`,
    "",
    `Return JSON: {"candidates":[...]} with ${count} candidates, best first, each having:`,
    '  url, parsePath, comparator ("gt"|"gte"|"lt"|"lte"|"eq"), threshold (decimal STRING),',
    "  valueScale (integer), confidence (0..1), and rationale — ONE sentence a human reads to",
    '  decide whether the rule matches the question, e.g. "resolves YES if Coinbase spot BTC/USD',
    '  is above 90,000 at the deadline".',
    "Use a DIFFERENT HOST for each candidate so one source outage cannot kill every option.",
    "Appending a query parameter to the same endpoint does NOT make it a different source; two",
    "candidates that read the same host and path are one candidate and will be discarded.",
  ];

  if (feedback?.length) {
    lines.push(
      "",
      "Your previous attempt was FETCHED and CHECKED against the live endpoints. These candidates",
      "were rejected — fix the causes, and do not repeat a rejected url/parsePath pair:",
      ...feedback.map((f) => `  - ${f}`),
    );
  }
  return lines.join("\n");
}

/** Mirrors the fields `validateProposal` reads, so the model returns parseable JSON on the first try. */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    candidates: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          url: { type: "STRING" },
          parsePath: { type: "STRING" },
          comparator: { type: "STRING", enum: ["gt", "gte", "lt", "lte", "eq"] },
          threshold: { type: "STRING" },
          valueScale: { type: "INTEGER" },
          confidence: { type: "NUMBER" },
          rationale: { type: "STRING" },
        },
        required: ["url", "parsePath", "comparator", "threshold", "valueScale", "rationale"],
      },
    },
  },
  required: ["candidates"],
};

/**
 * The Gemini-backed model. Low temperature and a JSON response mime type: this
 * is a recall-and-format task, and sampling variety here buys nothing but
 * hallucinated hostnames.
 */
export function createGeminiModel({ apiKey, model = DEFAULT_MODEL, fetchImpl = fetch }) {
  const keys = splitKeys(apiKey);
  if (keys.length === 0) throw new Error("GEMINI_API_KEY is not set");

  // Where the next request starts. Sticky rather than round-robin: a key that
  // just worked is the cheapest one to try again, and spraying across keys
  // would burn every daily allowance at the same rate instead of in turn.
  let cursor = 0;

  /**
   * One call, tried against each key until one is not out of quota.
   *
   * Only exhaustion and rate limiting move to the next key. A 400 or a 403 is
   * a property of the REQUEST, not the key, so retrying it across every key
   * would multiply one mistake by the size of the keyring.
   */
  async function call(body) {
    let last = null;
    for (let i = 0; i < keys.length; i++) {
      const index = (cursor + i) % keys.length;
      const res = await fetchImpl(`${API_BASE}/${model}:generateContent?key=${keys[index]}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (res.ok) {
        cursor = index;
        return res;
      }
      if (res.status !== 429) return res;
      last = res;
    }
    return last;
  }

  return {
    async propose({ question, feedback = [], count = 3 }) {
      const res = await call(
        JSON.stringify({
          contents: [{ role: "user", parts: [{ text: buildPrompt({ question, feedback, count }) }] }],
          generationConfig: {
            temperature: 0.1,
            topP: 0.8,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            // Reasoning tokens are billed against this same ceiling, and the
            // model spends hundreds of them recalling response shapes. Sized
            // for thinking PLUS the JSON: too low truncates mid-object, which
            // surfaces as "model did not return JSON" and burns a retry.
            maxOutputTokens: 8192,
          },
        }),
      );
      if (!res.ok) {
        // Not retryable: a 429 or a bad key answers the same way three times,
        // and the loop would spend the caller's remaining quota finding out.
        throw new Error(`Gemini returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = await res.json();
      const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
      return parseProposals(text);
    },

    /** Best-effort. A null return means "show the creator's own wording". */
    async polish({ question }) {
      const res = await call(
        JSON.stringify({
          contents: [{ role: "user", parts: [{ text: buildPolishPrompt({ question }) }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            responseSchema: POLISH_SCHEMA,
            // Reasoning tokens are billed against this ceiling and cannot be
            // switched off on this model (`thinkingBudget: 0` is a 400), so the
            // only lever is headroom. Rewriting one sentence costs ~500 thought
            // tokens; at the original 512 the JSON was truncated mid-string and
            // the whole suggestion silently became "no suggestion".
            maxOutputTokens: 2048,
          },
        }),
      );
      if (!res?.ok) return null;
      const body = await res.json();
      const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
      return parsePolish(text, question);
    },
  };
}

/**
 * A malformed answer, as opposed to a refused request.
 *
 * The usual cause is the response hitting the token ceiling mid-object, which
 * is a property of one sampling run and not of the request — so the loop is
 * allowed to ask again, where it must not for a 429 or a bad key.
 */
function retryable(message) {
  const e = new Error(message);
  e.retryable = true;
  return e;
}

/**
 * Pulls the candidate array out of the model's text.
 *
 * Tolerant of a bare array or a code fence because a malformed envelope is a
 * formatting slip, not a reason to fail a request — but never tolerant of the
 * candidates themselves, which the validator judges on their own merits.
 */
export function parseProposals(text) {
  const trimmed = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw retryable(`model did not return JSON: ${trimmed.slice(0, 200)}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.candidates;
  if (!Array.isArray(list)) throw retryable("model response has no candidates array");
  return list;
}


/**
 * The prompt that tightens the creator's question without taking it over.
 *
 * A question and a rule are committed together and neither can be edited, so a
 * precise rule under a vague question is still a broken market: the rule says
 * what settles, the question is what people believed they were betting on, and
 * a dispute is decided by reading the question. The gap between them is the
 * thing this closes.
 *
 * The hard constraint is that MEANING is preserved. Making an implicit
 * threshold explicit is the job; inventing a threshold the creator never chose
 * is a different market than the one they asked for, so an underspecified
 * question comes back unchanged with the gap named in `notes`.
 */
export function buildPolishPrompt({ question }) {
  return [
    "You tighten prediction-market questions. The question is committed on chain permanently",
    "alongside a machine rule, and when the two disagree a human adjudicator settles the market",
    "by reading the QUESTION. So the question must say, on its own, exactly what settles it.",
    "",
    "Rewrite it to be:",
    "  - a yes/no question with exactly one claim, answerable YES or NO and nothing else",
    "  - explicit about the subject, the numeric threshold, and the units",
    "  - explicit about direction: 'above'/'at or above' rather than 'hits' or 'reaches'",
    "  - free of vague time words ('soon', 'this year'); the deadline is a separate field, so",
    "    refer to it as 'by the deadline' rather than inventing a date",
    "",
    "PRESERVE THE MEANING. You may make an implicit threshold explicit and fix grammar, spelling",
    "and phrasing. You must NOT invent a threshold the question never implied, change a number,",
    "swap the subject, or flip the direction. If the question is too underspecified to tighten",
    "without choosing on the creator's behalf, return it UNCHANGED and say what is missing.",
    "",
    `Question: ${question}`,
    "",
    "Also classify the question into exactly one category:",
    `  ${CATEGORIES.join(", ")}`,
    "Use `others` only when none of the rest genuinely fits.",
    "",
    'Return JSON: {"polished": string, "changed": boolean, "notes": string, "category": string}.',
    "`changed` is false when you return the question as-is. `notes` is ONE short sentence: what",
    "you tightened, or what the creator still needs to decide. Keep `polished` under 200 characters.",
  ].join("\n");
}

/** The market categories this app buckets by; `others` is the honest fallback. */
export const CATEGORIES = [
  "sports",
  "tech",
  "cultures",
  "crypto",
  "politics",
  "weather",
  "others",
];

const POLISH_SCHEMA = {
  type: "OBJECT",
  properties: {
    polished: { type: "STRING" },
    changed: { type: "BOOLEAN" },
    notes: { type: "STRING" },
    category: { type: "STRING", enum: CATEGORIES },
  },
  required: ["polished", "changed"],
};

/** Longer than this is not a market question, and the form would not accept it back. */
const MAX_POLISHED = 300;

/**
 * Narrows the polish response.
 *
 * Returns null — never throws — whenever the model gave back something not
 * worth showing: empty, over-long, or identical to the input. The caller
 * renders a suggestion or renders nothing, and a bad suggestion must never
 * cost the creator the candidates that came back in the same request.
 */
export function parsePolish(text, original) {
  let parsed;
  try {
    parsed = JSON.parse(
      String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, ""),
    );
  } catch {
    return null;
  }
  const polished = typeof parsed?.polished === "string" ? parsed.polished.trim() : "";
  if (polished.length === 0 || polished.length > MAX_POLISHED) return null;

  const notes = typeof parsed?.notes === "string" ? parsed.notes.trim() : "";
  // The model's own `changed` flag is advisory; the text is what decides, so a
  // model that says "changed" while echoing the input still reads as unchanged.
  const changed = polished !== original.trim();
  // A category outside the app's own set would be dropped silently downstream;
  // naming it `others` keeps the market in a bucket that exists.
  const raw = typeof parsed?.category === "string" ? parsed.category.trim().toLowerCase() : "";
  const category = CATEGORIES.includes(raw) ? raw : null;
  return { polished, changed, notes, category };
}
