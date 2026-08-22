// The loop: a rejection must come back to the model as feedback, and only
// fetched-and-parsed candidates may leave.

import assert from "node:assert/strict";
import test from "node:test";
import { draft } from "../src/draft.js";
import { goodProposal, stubFetch, stubModel } from "./helpers.js";

const GOOD_URL = goodProposal.url;
const routes = { [GOOD_URL]: { body: { data: { amount: "119042.35" } } } };

test("a first attempt that validates returns candidates and stops", async () => {
  const model = stubModel([[goodProposal, { ...goodProposal, url: GOOD_URL + "?x=1", confidence: 0.4 }]]);
  const r = await draft("Will BTC be above 90000?", { model, fetchImpl: stubFetch({ ...routes, [GOOD_URL + "?x=1"]: routes[GOOD_URL] }) });
  assert.equal(r.attempts, 1);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[0].confidence, 0.9, "best first");
  assert.equal(r.candidates[0].reading, "119042.35");
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
