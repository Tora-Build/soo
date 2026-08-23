// The wording suggestion: narrowed hard, because a bad one must cost nothing.

import assert from "node:assert/strict";
import test from "node:test";
import { buildPolishPrompt, parsePolish } from "../src/gemini.js";

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
