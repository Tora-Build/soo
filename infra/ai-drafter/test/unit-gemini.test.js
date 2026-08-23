// The wording suggestion: narrowed hard, because a bad one must cost nothing.

import assert from "node:assert/strict";
import test from "node:test";
import { buildPolishPrompt, parseDeadline, parsePolish } from "../src/gemini.js";

const ORIGINAL = "will btc hit 90k";

test("a tightened question comes back marked changed", () => {
  const r = parsePolish(
    JSON.stringify({
      polished: "Will Bitcoin be above $90,000 by the deadline?",
      changed: true,
      notes: "named the asset and made the direction explicit",
    }),
    ORIGINAL,
  );
  assert.equal(r.changed, true);
  assert.match(r.polished, /above \$90,000/);
  assert.match(r.notes, /direction/);
});

test("an echo of the input is not a suggestion, whatever the model claims", () => {
  // `changed` is the model's self-report; the text is what decides. Otherwise
  // the form offers the creator their own sentence back as an improvement.
  const r = parsePolish(JSON.stringify({ polished: ORIGINAL, changed: true }), ORIGINAL);
  assert.equal(r.changed, false);
});

test("unusable responses return null rather than throwing", () => {
  assert.equal(parsePolish("not json", ORIGINAL), null);
  assert.equal(parsePolish(JSON.stringify({ polished: "" }), ORIGINAL), null);
  assert.equal(parsePolish(JSON.stringify({ polished: "x".repeat(301) }), ORIGINAL), null);
  assert.equal(parsePolish(JSON.stringify({ notes: "no polished field" }), ORIGINAL), null);
});

test("a code-fenced response is still read", () => {
  const r = parsePolish('```json\n{"polished":"Will BTC be above $90,000?","changed":true}\n```', ORIGINAL);
  assert.equal(r.polished, "Will BTC be above $90,000?");
});

test("the polish prompt forbids inventing a threshold", () => {
  const prompt = buildPolishPrompt({ question: ORIGINAL });
  assert.match(prompt, /PRESERVE THE MEANING/);
  assert.match(prompt, /NOT invent a threshold/);
  assert.match(prompt, new RegExp(ORIGINAL));
});

// Key rotation. The free tier is capped per project per day and one demo
// session can reach it, so several keys is the only way up without billing.

import { createGeminiModel, splitKeys } from "../src/gemini.js";

const reply = (obj) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const quotaSpent = () => new Response("quota", { status: 429 });

/** Records which key each call carried. */
function spyFetch(handler) {
  const keys = [];
  return {
    keys,
    fetchImpl: async (url) => {
      const key = new URL(url).searchParams.get("key");
      keys.push(key);
      return handler(key);
    },
  };
}

test("splitKeys accepts commas and whitespace", () => {
  assert.deepEqual(splitKeys("a, b  c ,, d "), ["a", "b", "c", "d"]);
  assert.deepEqual(splitKeys(""), []);
  assert.deepEqual(splitKeys(undefined), []);
});

test("a key that is out of quota falls through to the next", async () => {
  const spy = spyFetch((key) => (key === "k1" ? quotaSpent() : reply({ candidates: [] })));
  const model = createGeminiModel({ apiKey: "k1,k2", fetchImpl: spy.fetchImpl });
  await model.propose({ question: "Will BTC be above 90000?" });
  assert.deepEqual(spy.keys, ["k1", "k2"], "tried the spent key, then the next");
});

test("the working key is reused rather than sprayed across the ring", async () => {
  // Round-robin would burn every daily allowance at the same rate instead of
  // spending them one at a time.
  const spy = spyFetch((key) => (key === "k1" ? quotaSpent() : reply({ candidates: [] })));
  const model = createGeminiModel({ apiKey: "k1,k2,k3", fetchImpl: spy.fetchImpl });
  await model.propose({ question: "Will BTC be above 90000?" });
  await model.propose({ question: "Will BTC be above 90000?" });
  assert.deepEqual(spy.keys, ["k1", "k2", "k2"], "second call starts at the key that worked");
});

test("a bad request is not retried across every key", async () => {
  // A 400 is a property of the request, so retrying it on each key would
  // multiply one mistake by the size of the keyring.
  const spy = spyFetch(() => new Response("bad", { status: 400 }));
  const model = createGeminiModel({ apiKey: "k1,k2,k3", fetchImpl: spy.fetchImpl });
  await assert.rejects(model.propose({ question: "Will BTC be above 90000?" }), /400/);
  assert.deepEqual(spy.keys, ["k1"]);
});

test("every key spent surfaces as the quota error", async () => {
  const spy = spyFetch(() => quotaSpent());
  const model = createGeminiModel({ apiKey: "k1,k2", fetchImpl: spy.fetchImpl });
  await assert.rejects(model.propose({ question: "Will BTC be above 90000?" }), /429/);
  assert.deepEqual(spy.keys, ["k1", "k2"]);
});

test("the question's category comes back with the polish", () => {
  const r = parsePolish(
    JSON.stringify({ polished: "Will BTC be above $90,000?", changed: true, category: "crypto" }),
    "will btc hit 90k",
  );
  assert.equal(r.category, "crypto");
});

test("a category outside the app's own set reads as none", () => {
  const r = parsePolish(
    JSON.stringify({ polished: "Will BTC be above $90,000?", changed: true, category: "finance" }),
    "will btc hit 90k",
  );
  assert.equal(r.category, null);
});

// Dates. The prompt used to say "refer to it as 'by the deadline' rather than
// inventing a date" unconditionally, so a date the creator DID write was
// deleted — "will lakers win by 2026?" came back as "by the deadline".

test("the prompt keeps a date the creator wrote", () => {
  const prompt = buildPolishPrompt({ question: "will lakers win by 2026?" });
  assert.match(prompt, /KEEP IT/);
  assert.match(prompt, /Never delete a date the creator wrote/);
  assert.match(prompt, /never invent one they did not/);
});

test("a named date comes back as the market's deadline", () => {
  const r = parsePolish(
    JSON.stringify({
      polished: "Will the Lakers win the NBA championship by 31 December 2026?",
      changed: true,
      category: "sports",
      deadline: "2026-12-31",
    }),
    "will lakers win by 2026?",
  );
  assert.equal(r.deadline, "2026-12-31");
});

test("a question with no date carries no deadline", () => {
  const r = parsePolish(
    JSON.stringify({ polished: "Will BTC be above $90,000 by the deadline?", changed: true }),
    "will btc hit 90k",
  );
  assert.equal(r.deadline, null);
});

test("only a real calendar date survives", () => {
  // The form sets the market's deadline from this, and a deadline is the one
  // field a market cannot be talked out of once it is on chain.
  for (const bad of ["2026-02-31", "31/12/2026", "2026-13-01", "next year", "2026", "", null, 20261231]) {
    assert.equal(parseDeadline(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(parseDeadline(" 2026-06-05 "), "2026-06-05");
  assert.equal(parseDeadline("2028-02-29"), "2028-02-29", "leap day is a day");
});
