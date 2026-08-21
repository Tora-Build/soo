// Rule-hash verification: the one place local configuration is reconciled
// with the chain's commitment. If this is wrong the resolver either refuses
// markets it should resolve, or requests attestations that can only ever be
// rejected on chain.

import assert from "node:assert/strict";
import { test } from "node:test";

import { sdk } from "../src/chain.mjs";
import { loadRegistry, validateEntry, verifyRule } from "../src/registry.mjs";
import { evaluateParsePath, toFixedPoint, fromFixedPoint, predictOutcome } from "../src/feed.mjs";

const { computeRuleHash } = sdk;

const URL_A = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
const PATH_A = "$.data.amount";

const entry = (over = {}) =>
  validateEntry({ market: "11111111111111111111111111111111", url: URL_A, parsePath: PATH_A, keyName: "amount", ...over }, 0);

test("a matching (url, parsePath) verifies against the on-chain rule hash", async () => {
  const onChain = await computeRuleHash(URL_A, PATH_A);
  const res = await verifyRule(entry(), onChain, computeRuleHash);
  assert.equal(res.ok, true);
  assert.equal(res.detail, null);
});

test("a different url fails verification", async () => {
  const onChain = await computeRuleHash("https://evil.example.com/price", PATH_A);
  const res = await verifyRule(entry(), onChain, computeRuleHash);
  assert.equal(res.ok, false);
  assert.match(res.detail, /different endpoint or field/);
});

test("the same url with a different parsePath fails verification", async () => {
  const onChain = await computeRuleHash(URL_A, "$.data.base");
  const res = await verifyRule(entry(), onChain, computeRuleHash);
  assert.equal(res.ok, false);
});

// The rule hash is length-prefixed precisely so no pair of (url, parsePath)
// can be re-cut into a different pair with the same hash. This is the property
// that stops a crafted registry entry from matching a market it does not
// describe.
test("the length prefix stops a re-cut (url, parsePath) pair from colliding", async () => {
  const a = await computeRuleHash("https://a.test/x", "$.b");
  const b = await computeRuleHash("https://a.test/", "x$.b");
  assert.notDeepEqual(Array.from(a), Array.from(b));
});

test("verification hashes UTF-8 bytes, not JS string length", async () => {
  const url = "https://api.test/prix?devise=€";
  const onChain = await computeRuleHash(url, PATH_A);
  const res = await verifyRule(entry({ url }), onChain, computeRuleHash);
  assert.equal(res.ok, true);
});

// ── Registry validation ───────────────────────────────────────────────────

test("a registry entry missing a required field is rejected by name", () => {
  assert.throws(() => validateEntry({ url: URL_A, parsePath: PATH_A, keyName: "a" }, 0), /"market"/);
  assert.throws(() => validateEntry({ market: "m", parsePath: PATH_A, keyName: "a" }, 0), /"url"/);
  assert.throws(() => validateEntry({ market: "m", url: URL_A, keyName: "a" }, 0), /"parsePath"/);
  assert.throws(() => validateEntry({ market: "m", url: URL_A, parsePath: PATH_A }, 0), /"keyName"/);
});

test("a malformed url is rejected", () => {
  assert.throws(() => validateEntry({ market: "m", url: "not-a-url", parsePath: PATH_A, keyName: "a" }, 0), /not a valid URL/);
});

test("the shipped markets.json parses", () => {
  const loaded = loadRegistry(new URL("../markets.json", import.meta.url).pathname);
  assert.ok(Array.isArray(loaded));
});

// ── parsePath evaluation ──────────────────────────────────────────────────

test("parsePath walks objects and array indices", () => {
  const body = { data: { amount: "64000.5", list: [{ v: 1 }, { v: 2 }] } };
  assert.equal(evaluateParsePath(body, "$.data.amount"), "64000.5");
  assert.equal(evaluateParsePath(body, "$.data.list[1].v"), 2);
  assert.equal(evaluateParsePath(body, "$['data']['amount']"), "64000.5");
});

// A rule that can select more than one value is not a rule — the chain has no
// way to arbitrate which one was meant.
test("multi-valued parsePath syntax is refused rather than guessed at", () => {
  const body = { data: { list: [1, 2] } };
  assert.throws(() => evaluateParsePath(body, "$.data.list[*]"), /more than one value/);
  assert.throws(() => evaluateParsePath(body, "$..amount"), /more than one value/);
});

test("a parsePath that does not resolve says where it stopped", () => {
  assert.throws(() => evaluateParsePath({ data: {} }, "$.data.amount.x"), /nothing at/);
});

// ── Fixed point ───────────────────────────────────────────────────────────

test("fixed-point conversion matches the on-chain scale rule", () => {
  assert.equal(toFixedPoint("64000.5", 6), 64_000_500_000n);
  assert.equal(toFixedPoint("64000", 6), 64_000_000_000n);
  assert.equal(toFixedPoint("0.000001", 6), 1n);
});

// The program rejects excess precision rather than truncating. Truncating here
// would let the resolver predict an outcome the chain computes differently.
test("excess precision is refused, not truncated", () => {
  assert.throws(() => toFixedPoint("64000.1234567", 6), /more than the market's scale/);
});

test("fixed point round-trips through its display form", () => {
  assert.equal(fromFixedPoint(64_000_500_000n, 6), "64000.500000");
  assert.equal(fromFixedPoint(1n, 6), "0.000001");
  assert.equal(fromFixedPoint(5n, 0), "5");
});

test("the predicted outcome matches each comparator at its boundary", () => {
  const t = 64_000_000_000n;
  assert.equal(predictOutcome(t, 1, t), 0, "Gt is false at the boundary");
  assert.equal(predictOutcome(t, 2, t), 1, "Gte is true at the boundary");
  assert.equal(predictOutcome(t, 3, t), 0, "Lt is false at the boundary");
  assert.equal(predictOutcome(t, 4, t), 1, "Lte is true at the boundary");
  assert.equal(predictOutcome(t, 5, t), 1, "Eq is true at the boundary");
  assert.equal(predictOutcome(t + 1n, 1, t), 1);
  assert.equal(predictOutcome(t - 1n, 1, t), 0);
});
