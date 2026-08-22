// The model seam.
//
// `draft()` depends on the SHAPE below and nothing else: an object with
// `propose({ question, feedback, count })` returning an array of raw proposals.
// Gemini is one implementation; the tests supply another. That is what lets the
// entire validation and retry path be exercised with no API key, which matters
// because the validator — not the model — is the part that must be right.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

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
    "Prefer well-known, stable, long-lived public endpoints that you are confident about — the",
    "kind whose response shape you have actually seen. A famous endpoint you can recall exactly",
    "beats an obscure one you are guessing at. Do not invent hostnames or paths.",
    "",
    "Write parsePath as JSONPath naming exactly one leaf field, exactly as it appears in the real",
    "response, e.g. $.data.amount or $.market_data.current_price.usd. No wildcards, no filters,",
    "no recursive descent, no array slices.",
    "",
    "Take the threshold from the question's own wording; do not round it or invent your own.",
    "Set comparator so that the rule resolves YES exactly when the question is true.",
    "",
    "valueScale is the number of decimals of headroom the on-chain fixed-point value carries.",
    "Attested precision varies between readings and the program REJECTS a value with more",
    "decimals than the scale rather than truncating it, so leave room: use 8 for prices and",
    "rates, and never a scale sized exactly to one reading you expect.",
    "",
    `Question: ${question}`,
    "",
    `Return JSON: {"candidates":[...]} with ${count} candidates, best first, each having:`,
    '  url, parsePath, comparator ("gt"|"gte"|"lt"|"lte"|"eq"), threshold (decimal STRING),',
    "  valueScale (integer), confidence (0..1), and rationale — ONE sentence a human reads to",
    '  decide whether the rule matches the question, e.g. "resolves YES if Coinbase spot BTC/USD',
    '  is above 90,000 at the deadline".',
    "Use different endpoints across candidates so a source outage does not kill every option.",
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
export function createGeminiModel({ apiKey, model = "gemini-3.6-flash", fetchImpl = fetch }) {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  return {
    async propose({ question, feedback = [], count = 3 }) {
      const res = await fetchImpl(`${API_BASE}/${model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: buildPrompt({ question, feedback, count }) }] }],
          generationConfig: {
            temperature: 0.1,
            topP: 0.8,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            maxOutputTokens: 4096,
          },
        }),
      });
      if (!res.ok) {
        throw new Error(`Gemini returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = await res.json();
      const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
      return parseProposals(text);
    },
  };
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
    throw new Error(`model did not return JSON: ${trimmed.slice(0, 200)}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.candidates;
  if (!Array.isArray(list)) throw new Error("model response has no candidates array");
  return list;
}
