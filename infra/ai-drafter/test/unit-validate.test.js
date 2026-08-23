// The validator is the part that must be right: a market's (url, parsePath) is
// committed permanently, so anything that slips through here is unfixable.

import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RESPONSE_BYTES, validateProposal } from "../src/validate.js";
import { goodProposal, stubFetch } from "./helpers.js";

const URL_ = goodProposal.url;
const live = { data: { base: "BTC", currency: "USD", amount: "119042.35" } };

test("a valid proposal passes through carrying the value actually fetched", async () => {
  const r = await validateProposal(goodProposal, { fetchImpl: stubFetch({ [URL_]: { body: live } }) });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.candidate.reading, "119042.35");
  assert.equal(r.candidate.url, URL_);
  assert.equal(r.candidate.parsePath, "$.data.amount");
  assert.equal(r.candidate.comparator, "gt");
  assert.equal(r.candidate.threshold, "90000");
  assert.equal(r.candidate.valueScale, 8);
});

test("a URL that 404s is rejected", async () => {
  const r = await validateProposal(goodProposal, { fetchImpl: stubFetch({}) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /HTTP 404/);
});

test("a URL that cannot be reached at all is rejected", async () => {
  const r = await validateProposal(goodProposal, {
    fetchImpl: () => Promise.reject(new Error("getaddrinfo ENOTFOUND feed.example")),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ENOTFOUND/);
});

test("a path resolving to nothing is rejected", async () => {
  const r = await validateProposal(
    { ...goodProposal, parsePath: "$.data.price" },
    { fetchImpl: stubFetch({ [URL_]: { body: live } }) },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /resolves to undefined/);
});

test("a path whose parent is missing is rejected", async () => {
  const r = await validateProposal(
    { ...goodProposal, parsePath: "$.result.amount" },
    { fetchImpl: stubFetch({ [URL_]: { body: live } }) },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not resolve|resolves to undefined/);
});

test("a path resolving to an object is rejected", async () => {
  const r = await validateProposal(
    { ...goodProposal, parsePath: "$.data" },
    { fetchImpl: stubFetch({ [URL_]: { body: live } }) },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /an object/);
});

test("a path resolving to an array is rejected", async () => {
  const r = await validateProposal(
    { ...goodProposal, parsePath: "$.data.series" },
    { fetchImpl: stubFetch({ [URL_]: { body: { data: { series: [1, 2, 3] } } } }) },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /an array/);
});

test("a non-numeric value is rejected", async () => {
  const r = await validateProposal(
    { ...goodProposal, parsePath: "$.data.base" },
    { fetchImpl: stubFetch({ [URL_]: { body: live } }) },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a bare decimal/);
});

test("NaN and null readings are rejected", async () => {
  const routes = { [URL_]: { body: { data: { amount: null } } } };
  const r = await validateProposal(goodProposal, { fetchImpl: stubFetch(routes) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a number/);

  const r2 = await validateProposal(goodProposal, {
    fetchImpl: stubFetch({ [URL_]: { body: { data: { amount: "NaN" } } } }),
  });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /not a bare decimal/);
});

test("a boolean reading is rejected", async () => {
  const r = await validateProposal(goodProposal, {
    fetchImpl: stubFetch({ [URL_]: { body: { data: { amount: true } } } }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /boolean/);
});

test("a huge response is rejected, by declared length and by streamed bytes", async () => {
  const big = JSON.stringify({ data: { amount: "1", pad: "x".repeat(MAX_RESPONSE_BYTES) } });

  const declared = await validateProposal(goodProposal, {
    fetchImpl: stubFetch({ [URL_]: { body: big, headers: { "content-length": String(big.length) } } }),
  });
  assert.equal(declared.ok, false);
  assert.match(declared.reason, /over the .* ceiling/);

  const streamed = await validateProposal(goodProposal, {
    fetchImpl: stubFetch({ [URL_]: { body: big } }),
  });
  assert.equal(streamed.ok, false);
  assert.match(streamed.reason, /over the .* ceiling/);
});

test("an endpoint demanding auth is rejected", async () => {
  const r = await validateProposal(goodProposal, {
    fetchImpl: stubFetch({ [URL_]: { body: {}, status: 401 } }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /requires authentication/);

  const challenged = await validateProposal(goodProposal, {
    fetchImpl: stubFetch({ [URL_]: { body: live, headers: { "www-authenticate": "Bearer" } } }),
  });
  assert.equal(challenged.ok, false);
  assert.match(challenged.reason, /requires authentication/);
});

test("a key-gated URL is rejected before any fetch happens", async () => {
  let fetched = false;
  const r = await validateProposal(
    { ...goodProposal, url: "https://feed.example/v1/price?api_key=abc" },
    { fetchImpl: () => ((fetched = true), Promise.resolve(new Response("{}"))) },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /key-gated/);
  assert.equal(fetched, false);
});

test("a non-https URL is rejected", async () => {
  const r = await validateProposal(
    { ...goodProposal, url: "http://feed.example/v1/price" },
    { fetchImpl: stubFetch({}) },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /not https/);
});

test("a wildcard path is rejected — a rule must name exactly one value", async () => {
  const r = await validateProposal(
    { ...goodProposal, parsePath: "$.data[*].amount" },
    { fetchImpl: stubFetch({ [URL_]: { body: live } }) },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /wildcard/);
});

test("a non-JSON response is rejected", async () => {
  const r = await validateProposal(goodProposal, {
    fetchImpl: stubFetch({ [URL_]: { body: "<html>nope</html>" } }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /did not return JSON/);
});

test("a bad comparator, threshold or scale is rejected", async () => {
  const fetchImpl = stubFetch({ [URL_]: { body: live } });
  for (const [patch, pattern] of [
    [{ comparator: "above" }, /comparator/],
    [{ threshold: "ninety thousand" }, /threshold/],
    [{ valueScale: 2.5 }, /valueScale/],
    [{ threshold: "90000.123", valueScale: 2 }, /excess precision/],
    [{ rationale: "" }, /rationale/],
  ]) {
    const r = await validateProposal({ ...goodProposal, ...patch }, { fetchImpl });
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(patch)}`);
    assert.match(r.reason, pattern);
  }
});

test("a scale with no headroom is corrected, not rejected", async () => {
  // The right scale is a function of the reading, which the validator has just
  // measured. Refusing a sound endpoint over a guess it can fix itself threw
  // away the answer to punish the guess.
  const r = await validateProposal(
    { ...goodProposal, valueScale: 2 },
    { fetchImpl: stubFetch({ [URL_]: { body: live } }) },
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.candidate.valueScale, 8, "raised to the floor for prices");
});

test("a high-precision feed raises the scale above the proposed one", async () => {
  // The live regression: a correct ISS altitude feed reading 418.22639781403
  // was rejected because the model proposed the 8 that suits prices.
  const precise = { data: { amount: "418.22639781403" } };
  const r = await validateProposal(
    { ...goodProposal, valueScale: 8 },
    { fetchImpl: stubFetch({ [URL_]: { body: precise } }) },
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.candidate.reading, "418.22639781403");
  assert.equal(r.candidate.valueScale, 13, "11 decimals seen, plus headroom");
});

test("a proposed scale larger than needed is left alone", async () => {
  // Correction only ever raises: the chain rejects too much precision, never
  // too little, so lowering a creator's scale could only break a settlement.
  const r = await validateProposal(
    { ...goodProposal, valueScale: 14 },
    { fetchImpl: stubFetch({ [URL_]: { body: live } }) },
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.candidate.valueScale, 14);
});

test("a reading too precise for the fixed point is still rejected", async () => {
  const absurd = { data: { amount: "1.12345678901234567890" } };
  const r = await validateProposal(goodProposal, {
    fetchImpl: stubFetch({ [URL_]: { body: absurd } }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /decimals/);
});
