// Gemini: advisory only, and strictly OFF the resolution path.
//
// # The boundary, stated once
//
// An outcome is decided by exactly one thing: the on-chain comparator, applied
// to a value that came out of a signed attestation. That happens inside
// `sooth_core`, in `zk::verify_attestation`. No language model participates in
// it, and no code in this file is reachable from `resolveMarket` — the
// resolution loop never imports this module.
//
// What Gemini may do here is help a HUMAN author a rule before it goes on
// chain, and flag a registry entry that reads as ambiguous. Both are
// pre-registration authoring aids whose output a person reads and acts on.
// Neither produces a value, an outcome, or a transaction.
//
// This boundary is not a matter of discipline, it is structural: the model is
// never handed an attestation, and the only thing it returns is prose. Even a
// maximally wrong answer from `reviewRule` cannot change what a market
// resolves to, because the market's rule is already committed as `rule_hash`
// and the outcome is computed on chain from a signature this file never sees.
//
// Usage is manual:  node src/index.mjs --review

const MODEL = "gemini-2.0-flash";
const ENDPOINT = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

/**
 * Asks Gemini whether a registry entry reads as an unambiguous, mechanically
 * checkable rule.
 *
 * Returns prose for a human. The caller prints it; nothing parses it, and no
 * branch anywhere depends on its content.
 */
export async function reviewRule({ apiKey, entry, onChain }) {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const prompt = [
    "You are reviewing a prediction-market resolution rule before it is committed on chain.",
    "You are NOT deciding an outcome and you are NOT being given any data value.",
    "Your only job is to say whether this rule is unambiguous and mechanically checkable.",
    "",
    `Endpoint:    ${entry.url}`,
    `Field path:  ${entry.parsePath}`,
    `Key name:    ${entry.keyName}`,
    `Question:    ${onChain?.question ?? "(unknown)"}`,
    `Comparator:  ${onChain?.comparatorName ?? "(unknown)"} ${onChain?.thresholdDisplay ?? ""}`,
    "",
    "Answer briefly:",
    "1. Does the field path name exactly one value in a typical response from that endpoint?",
    "2. Could the endpoint's shape or units change in a way that silently breaks the rule?",
    "3. Does the question match what the comparator and threshold actually test?",
    "4. AMBIGUOUS or CLEAR, in one word, on the last line.",
  ].join("\n");

  const res = await fetch(ENDPOINT(MODEL, apiKey), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    throw new Error(`Gemini returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  return text.trim() || "(no response)";
}
