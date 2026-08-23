// The loop: a rejection must come back to the model as feedback, and only
// fetched-and-parsed candidates may leave.

import assert from "node:assert/strict";
import test from "node:test";
import { draft } from "../src/draft.js";
import { goodProposal, stubFetch, stubModel } from "./helpers.js";

const GOOD_URL = goodProposal.url;
const routes = { [GOOD_URL]: { body: { data: { amount: "119042.35" } } } };

const OTHER_URL = "https://other.example/v1/spot";
const otherProposal = { ...goodProposal, url: OTHER_URL, confidence: 0.4 };
const bothRoutes = { ...routes, [OTHER_URL]: routes[GOOD_URL] };

test("a first attempt that validates returns candidates and stops", async () => {
  const model = stubModel([[goodProposal, otherProposal]]);
  const r = await draft("Will BTC be above 90000?", { model, fetchImpl: stubFetch(bothRoutes) });
  assert.equal(r.attempts, 1);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[0].confidence, 0.9, "best first");
  assert.equal(r.candidates[0].reading, "119042.35");
});

test("the same endpoint under a cosmetic query parameter is one candidate", async () => {
  // The failure this guards: asked for distinct sources, a model appends
  // `?ref=...` and returns one feed three times. Keyed on the full URL those
  // look distinct, so the creator is offered a choice that is not one.
  const disguised = { ...goodProposal, url: GOOD_URL + "?ref=oracle", confidence: 0.5 };
  const model = stubModel([[goodProposal, disguised, otherProposal]]);
  const r = await draft("Will BTC be above 90000?", {
    model,
    fetchImpl: stubFetch({ ...bothRoutes, [GOOD_URL + "?ref=oracle"]: routes[GOOD_URL] }),
  });

  const urls = r.candidates.map((c) => c.url);
  assert.equal(urls.filter((u) => u.startsWith(GOOD_URL)).length, 1, "the clone is dropped");
  assert.ok(urls.includes(OTHER_URL), "the genuinely different host survives");
});

test("candidates are spread across hosts before confidence backfills", async () => {
  // A second reading of the best host must not outrank the only other host:
  // three candidates that share an outage are one candidate for the purpose
  // the list exists to serve.
  const sameHostOtherField = {
    ...goodProposal,
    url: "https://feed.example/v2/prices/BTC-USD/buy",
    parsePath: "$.data.amount",
    confidence: 0.8,
  };
  const model = stubModel([[goodProposal, sameHostOtherField, otherProposal]]);
  const r = await draft("Will BTC be above 90000?", {
    model,
    fetchImpl: stubFetch({ ...bothRoutes, [sameHostOtherField.url]: routes[GOOD_URL] }),
  });

  assert.equal(r.candidates.length, 3);
  assert.deepEqual(
    r.candidates.map((c) => new URL(c.url).host),
    ["feed.example", "other.example", "feed.example"],
    "one per host first, in confidence order, then the remainder",
  );
});

test("a rejected first attempt is retried WITH the failure as feedback", async () => {
  const dead = { ...goodProposal, url: "https://dead.example/price" };
  const model = stubModel([[dead], [goodProposal]]);

  // Two attempts only: one candidate is already enough to show the feedback
  // round trip, and the loop would otherwise keep spending calls chasing a second.
  const r = await draft("Will BTC be above 90000?", { model, fetchImpl: stubFetch(routes), maxAttempts: 2 });

  assert.equal(model.calls.length, 2);
  assert.deepEqual(model.calls[0].feedback, []);
  assert.equal(model.calls[1].feedback.length, 1);
  assert.match(model.calls[1].feedback[0], /dead\.example/);
  assert.match(model.calls[1].feedback[0], /HTTP 404/);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].url, GOOD_URL);
});

test("the loop is bounded and returns nothing rather than junk", async () => {
  const bad = { ...goodProposal, url: "https://dead.example/price" };
  const model = stubModel([[bad]]);
  const r = await draft("Will BTC be above 90000?", { model, fetchImpl: stubFetch(routes), maxAttempts: 3 });
  assert.equal(r.candidates.length, 0);
  assert.equal(model.calls.length, 3);
  assert.equal(r.rejections.length, 1, "a repeated url/parsePath pair is not re-fetched");
});

test("a repeat proposal is not re-fetched, and later attempts still add candidates", async () => {
  const bad = { ...goodProposal, url: "https://dead.example/price" };
  const model = stubModel([[bad], [bad, goodProposal]]);
  const r = await draft("Will BTC be above 90000?", { model, fetchImpl: stubFetch(routes), maxAttempts: 2 });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.attempts, 2);
});

test("a model that throws with nothing accepted surfaces the error", async () => {
  const model = stubModel([new Error("Gemini returned HTTP 429")]);
  await assert.rejects(
    () => draft("Will BTC be above 90000?", { model, fetchImpl: stubFetch(routes) }),
    /HTTP 429/,
  );
});

test("a model that throws AFTER a candidate validated keeps the candidate", async () => {
  const model = stubModel([[goodProposal], new Error("Gemini exploded")]);
  const r = await draft("Will BTC be above 90000?", {
    model,
    fetchImpl: stubFetch(routes),
    maxAttempts: 2,
  });
  assert.equal(r.candidates.length, 1);
});

test("a mangled model answer is retried; a refused request is not", async () => {
  // The distinction matters because the free tier is small: retrying a 429
  // three times spends the remaining daily quota learning the same thing.
  const truncated = Object.assign(new Error("model did not return JSON"), { retryable: true });
  const retried = stubModel([truncated, [goodProposal]]);
  const r = await draft("Will BTC be above 90000?", {
    model: retried,
    fetchImpl: stubFetch(routes),
    maxAttempts: 2,
  });
  assert.equal(retried.calls.length, 2, "asked again after a mangled answer");
  assert.equal(r.candidates.length, 1);

  const refused = stubModel([new Error("Gemini returned HTTP 429")]);
  await assert.rejects(
    draft("Will BTC be above 90000?", { model: refused, fetchImpl: stubFetch(routes) }),
    /429/,
  );
  assert.equal(refused.calls.length, 1, "a refusal is not retried");
});
