// The validator against a real, key-free endpoint.
//
// The unit tests prove the rejections; this proves the acceptance is not a
// fiction — the same endpoint an existing devnet market already resolves
// against (see infra/zk-resolver/markets.json) validates here and returns the
// live number. Needs network; no API key of any kind.

import assert from "node:assert/strict";
import test from "node:test";
import { validateProposal } from "../src/validate.js";

test("Coinbase BTC-USD spot validates and yields a real number", async () => {
  const r = await validateProposal(
    {
      url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      parsePath: "$.data.amount",
      comparator: "gt",
      threshold: "90000",
      valueScale: 8,
      confidence: 0.95,
      rationale: "resolves YES if Coinbase spot BTC/USD is above 90,000 at the deadline",
    },
    { timeoutMs: 10_000 },
  );

  assert.equal(r.ok, true, r.reason);
  assert.ok(Number.isFinite(Number(r.candidate.reading)));
  assert.ok(Number(r.candidate.reading) > 0);
  assert.ok(r.bytes < 1024, `response was ${r.bytes} bytes`);
  console.log(JSON.stringify(r.candidate, null, 2));
});

test("the same endpoint with a wrong path is rejected against the live response", async () => {
  const r = await validateProposal(
    {
      url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      parsePath: "$.data.price",
      comparator: "gt",
      threshold: "90000",
      valueScale: 8,
      rationale: "resolves YES if Coinbase spot BTC/USD is above 90,000 at the deadline",
    },
    { timeoutMs: 10_000 },
  );
  assert.equal(r.ok, false);
  console.log("rejection:", r.reason);
});

test("the whole /draft path, real network, stubbed model", async () => {
  const { handle } = await import("../src/index.js");
  const { reset } = await import("../src/ratelimit.js");
  reset();

  const model = {
    calls: [],
    async propose(args) {
      model.calls.push(args);
      // First turn proposes one dead endpoint and one real one, so the retry
      // feedback and the live acceptance are both exercised end to end.
      return [
        {
          url: "https://api.coinbase.com/v2/prices/BTC-USD/nope",
          parsePath: "$.data.amount",
          comparator: "gt",
          threshold: "90000",
          valueScale: 8,
          rationale: "resolves YES if Coinbase spot BTC/USD is above 90,000 at the deadline",
        },
        {
          url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
          parsePath: "$.data.amount",
          comparator: "gt",
          threshold: "90000",
          valueScale: 8,
          confidence: 0.95,
          rationale: "resolves YES if Coinbase spot BTC/USD is above 90,000 at the deadline",
        },
      ];
    },
  };

  const res = await handle(
    new Request("https://drafter.example/draft", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "5.5.5.5" },
      body: JSON.stringify({ question: "Will BTC be above $90,000 on December 31?" }),
    }),
    {},
    null,
    { model },
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.candidates.length, 1);
  assert.ok(Number(body.candidates[0].reading) > 0);
  console.log(JSON.stringify(body, null, 2));
});
