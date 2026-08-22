// The proof endpoint, tested without spending a single unit of Primus quota.
//
// Every attestation here is a stub. That is not a convenience — a test suite
// that ran real attestations would burn the founder's balance on every `npm
// test`, which is precisely the failure mode the endpoint's budget exists to
// prevent. The one real end-to-end attestation is a manual step, documented in
// the README, and it runs once.

import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";

import {
  QuotaBudget,
  classifyPrefetchError,
  classifyPrimusError,
  createPreviewHandler,
  createPreviewServer,
  decimalPlaces,
  keyNameFor,
  validatePreviewRequest,
} from "../src/serve.mjs";

const PADO = "0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6";

/** A budget with a clock the test drives and no file behind it. */
function testBudget(overrides = {}) {
  let now = 1_000_000;
  const budget = new QuotaBudget({
    minIntervalMs: 1000,
    windowMs: 10_000,
    windowMax: 3,
    path: null,
    now: () => now,
    ...overrides,
  });
  budget.advance = (ms) => {
    now += ms;
  };
  return budget;
}

/** A stub attestation, shaped exactly like `primusPreviewer.attest` returns. */
const okAttest = async ({ url, parsePath, keyName }) => ({
  attestedValue: "76656.69",
  attestorAddress: PADO,
  elapsedMs: 4211,
  attestedAt: 1787319198412,
  digest: "0xdeadbeef",
  seen: { url, parsePath, keyName },
});

const okPrefetch = async () => ({ raw: "76656.69", body: {} });

function handlerWith({ attest = okAttest, prefetch = okPrefetch, budget = testBudget() } = {}) {
  return { handle: createPreviewHandler({ attest, prefetch, budget }), budget };
}

// ── The request shape ──────────────────────────────────────────────────────

test("a body missing url or parsePath is a 400, not an attestation", async () => {
  const { handle } = handlerWith();
  for (const body of [
    {},
    { url: "https://api.coinbase.com/v2/prices/BTC-USD/spot" },
    { parsePath: "$.data.amount" },
    { url: "", parsePath: "$.data.amount" },
    null,
    "not an object",
  ]) {
    const res = await handle(body);
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} should be a 400`);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.reason, "bad_request");
    assert.ok(res.body.detail.length > 0);
  }
});

test("a rule that could never be attested is refused before Primus is asked", async () => {
  let attempts = 0;
  const { handle } = handlerWith({
    attest: async () => {
      attempts += 1;
      return okAttest({});
    },
  });

  const cases = [
    ["http://api.example.com/x", "$.a", /https/],
    ["not a url", "$.a", /not a URL/],
    ["https://api.example.com/x", "data.amount", /must start with/],
    ["https://api.example.com/x", "$..amount", /wildcard|recursive/],
    ["https://api.example.com/x", "$.items[*].v", /wildcard|recursive/],
    [`https://api.example.com/${"x".repeat(600)}`, "$.a", /bytes/],
  ];
  for (const [url, parsePath, matcher] of cases) {
    const res = await handle({ url, parsePath });
    assert.equal(res.status, 400, `${url} ${parsePath}`);
    assert.match(res.body.detail, matcher);
  }
  assert.equal(attempts, 0, "no quota may be spent on a request that never validated");
});

test("keyName comes from the path's last segment", () => {
  assert.equal(keyNameFor("$.data.amount"), "amount");
  assert.equal(keyNameFor("$.result[0].price"), "price");
  assert.equal(keyNameFor("$['data']['last']"), "last");
  assert.equal(keyNameFor("$"), "value");
});

test("decimals are counted off the attested string, not a float", () => {
  assert.equal(decimalPlaces("76656.69"), 2);
  assert.equal(decimalPlaces("76656.690"), 3);
  assert.equal(decimalPlaces("76656"), 0);
});

// ── The happy path ─────────────────────────────────────────────────────────

test("a stubbed attestation returns the documented 200 shape", async () => {
  const { handle, budget } = handlerWith();
  const res = await handle({
    url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    parsePath: "$.data.amount",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    { ...res.body, quotaRemaining: undefined },
    {
      ok: true,
      attestedValue: "76656.69",
      decimals: 2,
      attestorAddress: PADO,
      elapsedMs: 4211,
      attestedAt: 1787319198412,
      digest: "0xdeadbeef",
      quotaRemaining: undefined,
    },
  );
  assert.equal(res.body.quotaRemaining, 2, "one unit of the window is spent");
  assert.equal(budget.inFlight, 0, "the in-flight slot is released");
});

// ── Diagnosis, not a stack trace ───────────────────────────────────────────

test("an endpoint that does not answer is a fetch refusal, and costs nothing", async () => {
  let attempts = 0;
  const { handle, budget } = handlerWith({
    prefetch: async () => {
      throw new Error("https://api.example.com/x returned HTTP 403");
    },
    attest: async () => {
      attempts += 1;
      return okAttest({});
    },
  });
  const res = await handle({ url: "https://api.example.com/x", parsePath: "$.a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, "fetch");
  assert.match(res.body.detail, /HTTP 403/);
  assert.equal(attempts, 0);
  assert.equal(budget.remaining(), 3, "a fetch refusal spends no quota");
});

test("a live endpoint whose path names nothing is a response refusal, still free", async () => {
  let attempts = 0;
  const { handle, budget } = handlerWith({
    prefetch: async () => {
      throw new Error("parsePath $.data.nope does not resolve: nothing at $.data.nope");
    },
    attest: async () => {
      attempts += 1;
      return okAttest({});
    },
  });
  const res = await handle({ url: "https://api.example.com/x", parsePath: "$.data.nope" });
  assert.equal(res.status, 200);
  assert.equal(res.body.reason, "response");
  assert.match(res.body.detail, /no quota spent/);
  assert.equal(attempts, 0);
  assert.equal(budget.remaining(), 3);
});

test("the pre-fetch tells a wrong url apart from a wrong path", () => {
  assert.equal(classifyPrefetchError(new Error("https://x/y returned HTTP 401")), "fetch");
  assert.equal(classifyPrefetchError(new Error("fetch failed")), "fetch");
  assert.equal(
    classifyPrefetchError(new Error("parsePath $.a does not resolve: nothing at $.a")),
    "response",
  );
  assert.equal(
    classifyPrefetchError(new Error("https://x/y $.a is {}, expected a string or number")),
    "response",
  );
});

test("each stage of a Primus failure gets its own reason", async () => {
  const cases = [
    [new Error("websocket closed before the session completed"), "proxy"],
    [new Error("attestation request timed out after 120000ms"), "proxy"],
    [new Error("appId quota exhausted"), "quota"],
    [Object.assign(new Error("recovered to 0xabc"), { previewReason: "attestor" }), "attestor"],
    [Object.assign(new Error("carries no scalar"), { previewReason: "response" }), "response"],
  ];
  for (const [err, reason] of cases) {
    const { handle } = handlerWith({
      attest: async () => {
        throw err;
      },
    });
    const res = await handle({ url: "https://api.example.com/x", parsePath: "$.a" });
    assert.equal(res.status, 200, "an unattestable rule is an answer, not an error");
    assert.equal(res.body.ok, false);
    assert.equal(res.body.reason, reason, err.message);
    // A reason, not a stack: the detail names the stage before the raw text.
    assert.ok(res.body.detail.length > err.message.length);
    assert.ok(!res.body.detail.includes("    at "), "no stack frames leak to the caller");
  }
});

test("classifyPrimusError falls back to the proxy session, never to a crash", () => {
  assert.equal(classifyPrimusError(new Error("something unheard of")), "proxy");
  assert.equal(classifyPrimusError(undefined), "proxy");
});

// ── The budget ─────────────────────────────────────────────────────────────

test("previews are serialised, spaced, and capped over a window", async () => {
  const budget = testBudget();
  const { handle } = handlerWith({ budget });
  const rule = { url: "https://api.example.com/x", parsePath: "$.a" };

  const first = await handle(rule);
  assert.equal(first.body.ok, true);

  const tooSoon = await handle(rule);
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.body.reason, "rate_limited");
  assert.ok(tooSoon.body.retryAfterMs > 0);

  budget.advance(1000);
  assert.equal((await handle(rule)).body.ok, true);
  budget.advance(1000);
  assert.equal((await handle(rule)).body.ok, true);

  budget.advance(1000);
  const capped = await handle(rule);
  assert.equal(capped.status, 429);
  assert.match(capped.body.detail, /budget of 3/);

  // The window rolls: past the oldest spend, the allowance comes back.
  budget.advance(10_000);
  assert.equal((await handle(rule)).body.ok, true);
});

test("a second preview cannot start while one is running", async () => {
  const budget = testBudget();
  let release;
  const { handle } = handlerWith({
    budget,
    attest: () => new Promise((res) => (release = () => res(okAttest({})))),
  });
  const rule = { url: "https://api.example.com/x", parsePath: "$.a" };

  const inFlight = handle(rule);
  await new Promise((r) => setImmediate(r));
  const concurrent = await handle(rule);
  assert.equal(concurrent.status, 429);
  assert.match(concurrent.body.detail, /already running/);

  release();
  assert.equal((await inFlight).body.ok, true);
});

// ── Transport ──────────────────────────────────────────────────────────────

async function withServer(opts, fn) {
  const budget = opts.budget ?? testBudget();
  const server = createPreviewServer({
    handlePreview: opts.handlePreview ?? createPreviewHandler({ attest: okAttest, prefetch: okPrefetch, budget }),
    token: opts.token ?? null,
    budget,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("without a token the endpoint answers; with one, an unauthorised call is 401", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/attest-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://api.example.com/x", parsePath: "$.a" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  let attempts = 0;
  const budget = testBudget();
  const handlePreview = createPreviewHandler({
    budget,
    prefetch: okPrefetch,
    attest: async (r) => {
      attempts += 1;
      return okAttest(r);
    },
  });
  await withServer({ token: "s3cret", handlePreview, budget }, async (base) => {
    const post = (headers) =>
      fetch(`${base}/attest-preview`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ url: "https://api.example.com/x", parsePath: "$.a" }),
      });

    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "s3cret" }]) {
      const res = await post(headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.equal((await res.json()).reason, "unauthorized");
    }
    assert.equal(attempts, 0, "an unauthorised caller never reaches Primus");

    const ok = await post({ authorization: "Bearer s3cret" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
    assert.equal(attempts, 1);
  });
});

test("bad JSON, a wrong method and an unknown path each say so", async () => {
  await withServer({}, async (base) => {
    const bad = await fetch(`${base}/attest-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).reason, "bad_request");

    const wrongMethod = await fetch(`${base}/attest-preview`);
    assert.equal(wrongMethod.status, 405);

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.attestor, PADO);
    assert.equal(body.tokenRequired, false);
  });
});

test("the request shape validator is exported and agrees with the handler", () => {
  assert.deepEqual(
    validatePreviewRequest({ url: " https://a.example/x ", parsePath: " $.a.b " }),
    { ok: true, url: "https://a.example/x", parsePath: "$.a.b" },
  );
});
