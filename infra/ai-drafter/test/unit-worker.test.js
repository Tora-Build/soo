// The HTTP surface, driven through the same `handle` the deployed Worker calls,
// with the model injected so no key is needed.

import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../src/index.js";
import { reset } from "../src/ratelimit.js";
import { goodProposal, stubFetch, stubModel } from "./helpers.js";

const routes = { [goodProposal.url]: { body: { data: { amount: "119042.35" } } } };
const post = (question, ip = "1.2.3.4") =>
  new Request("https://drafter.example/draft", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ question }),
  });

test("GET /health reports whether the key is configured", async () => {
  const bare = await handle(new Request("https://drafter.example/health"), {}, null, {});
  assert.deepEqual(await bare.json(), { ok: true, geminiConfigured: false });

  const keyed = await handle(new Request("https://drafter.example/health"), { GEMINI_API_KEY: "k" }, null, {});
  assert.deepEqual(await keyed.json(), { ok: true, geminiConfigured: true });
});

test("POST /draft returns validated candidates", async () => {
  reset();
  const res = await handle(post("Will BTC be above 90000 on Dec 31?"), {}, null, {
    model: stubModel([[goodProposal]]),
    fetchImpl: stubFetch(routes),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const body = await res.json();
  assert.equal(body.candidates.length, 1);
  assert.equal(body.candidates[0].reading, "119042.35");
});

test("POST /draft is 422 when nothing validated, and says why", async () => {
  reset();
  const res = await handle(post("Will BTC be above 90000 on Dec 31?"), {}, null, {
    model: stubModel([[{ ...goodProposal, url: "https://dead.example/p" }]]),
    fetchImpl: stubFetch(routes),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.rejections.length, 1);
  assert.match(body.rejections[0], /HTTP 404/);
});

test("a missing key is 503, never a fabricated candidate", async () => {
  reset();
  const res = await handle(post("Will BTC be above 90000 on Dec 31?"), {}, null, {});
  assert.equal(res.status, 503);
});

test("a junk question is 400", async () => {
  reset();
  const res = await handle(post("no"), {}, null, { model: stubModel([[goodProposal]]) });
  assert.equal(res.status, 400);
});

test("the per-IP limit stops a key from being drained", async () => {
  reset();
  const env = { RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_SECONDS: "600" };
  const deps = { model: stubModel([[goodProposal]]), fetchImpl: stubFetch(routes) };
  assert.equal((await handle(post("Will BTC be above 90000?"), env, null, deps)).status, 200);
  assert.equal((await handle(post("Will BTC be above 90000?"), env, null, deps)).status, 200);
  const limited = await handle(post("Will BTC be above 90000?"), env, null, deps);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  // A different caller is unaffected — the budget is per IP.
  assert.equal((await handle(post("Will BTC be above 90000?", "9.9.9.9"), env, null, deps)).status, 200);
});

test("OPTIONS preflight and unknown paths", async () => {
  const pre = await handle(new Request("https://drafter.example/draft", { method: "OPTIONS" }), {}, null, {});
  assert.equal(pre.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
  const missing = await handle(new Request("https://drafter.example/nope"), {}, null, {});
  assert.equal(missing.status, 404);
});
