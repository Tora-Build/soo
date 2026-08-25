// The catalog is only worth its prompt tokens if every entry is the shape the
// validator would accept. A malformed one teaches the model a bad pattern and
// costs a retry — the exact thing it exists to prevent.

import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG, catalogLines, deadlineFromQuestion, heuristicPolish } from "../src/catalog.js";

const NOW = Date.parse("2026-08-25");
import { buildPrompt } from "../src/gemini.js";
import { COMPARATORS } from "../src/validate.js";

test("every entry is public https, no key, no credentials", () => {
  for (const e of CATALOG) {
    const u = new URL(e.url);
    assert.equal(u.protocol, "https:", e.url);
    assert.equal(u.username, "", e.url);
    for (const name of u.searchParams.keys()) {
      assert.doesNotMatch(name, /^(api[-_]?key|apikey|key|token|secret)$/i, `${e.url} is key-gated`);
    }
  }
});

test("every entry names a single leaf field", () => {
  for (const e of CATALOG) {
    assert.ok(e.parsePath.startsWith("$"), e.parsePath);
    assert.doesNotMatch(e.parsePath, /\*|\.\.|\?\(/, `${e.parsePath} is not a single leaf`);
    assert.ok(e.what && e.what.length > 3, `${e.url} has no description`);
  }
});

test("no two entries are the same source", () => {
  // Two rows reading one host and path would offer the model a false choice,
  // which is the failure the dedup key exists to catch downstream.
  const keys = CATALOG.map((e) => {
    const u = new URL(e.url);
    return `${u.host}${u.pathname}|${e.parsePath}`.toLowerCase();
  });
  assert.equal(new Set(keys).size, keys.length, "duplicate source in the catalog");
});

test("the catalog reaches the prompt as a preference, not a restriction", () => {
  const prompt = buildPrompt({ question: "Will BTC be above 90000?", feedback: [], count: 3 });
  assert.match(prompt, /NOT a restriction/);
  assert.match(prompt, /propose your own/);
  for (const line of catalogLines()) {
    assert.ok(prompt.includes(line), `catalog line missing from prompt: ${line}`);
  }
});

test("comparators the catalog would be used with are the supported set", () => {
  assert.deepEqual(COMPARATORS, ["gt", "gte", "lt", "lte", "eq"]);
});

test("deadlineFromQuestion: bare year rounds to its end", () => {
  assert.equal(deadlineFromQuestion("btc above 100k by 2026?", NOW), "2026-12-31");
});

test("deadlineFromQuestion: month with year rounds to month end", () => {
  assert.equal(deadlineFromQuestion("rain by March 2027", NOW), "2027-03-31");
});

test("deadlineFromQuestion: bare month lands on the next occurrence", () => {
  // NOW is 2026-08-25 — December is still ahead this year.
  assert.equal(deadlineFromQuestion("eth above 5000 by december", NOW), "2026-12-31");
  // March has passed — it means March next year.
  assert.equal(deadlineFromQuestion("eth above 5000 by march", NOW), "2027-03-31");
});

test("deadlineFromQuestion: a verbatim ISO date wins", () => {
  assert.equal(deadlineFromQuestion("btc by 2026-10-01 exactly", NOW), "2026-10-01");
});

test("heuristicPolish carries category and deadline, never a rewording", () => {
  const p = heuristicPolish("btc price that reaches 100k by 2026?", NOW);
  assert.equal(p.changed, false);
  assert.equal(p.category, "crypto");
  assert.equal(p.deadline, "2026-12-31");
});
