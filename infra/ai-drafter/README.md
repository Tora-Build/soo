# soo-ai-drafter

A Cloudflare Worker that turns a market question into a resolution rule the
chain can check — and **fetches the endpoint before it answers**. Every
candidate it returns was retrieved and parsed to a finite number during that
request; `reading` is the value it actually saw.

This matters because a market commits to `sha256(len‖url‖len‖parsePath)` at
creation, permanently. A wrong URL or a path that names nothing cannot be
corrected and stays silent until settlement.

## Endpoint

```
POST /draft   { "question": "Will BTC be above $90,000 on December 31?" }
  200 { "candidates": [ { url, parsePath, comparator, threshold,
                          valueScale, reading, rationale, confidence } ],
        "attempts": 1 }
  400 question missing or out of range      422 nothing validated (see rejections)
  429 per-IP rate limit                     502 the model failed
  503 GEMINI_API_KEY not configured

GET  /health  ->  { "ok": true, "geminiConfigured": true }
```

`comparator` is `gt|gte|lt|lte|eq`, `threshold` a decimal string, `valueScale`
the decimals of fixed-point headroom (8 for prices).

## What it refuses

A candidate is dropped, with the reason fed back to the model for a retry
(3 attempts), unless all of this holds against the live endpoint:

- https, no credentials in the URL, no `api_key`/`token`/`key` query parameter
- plain GET with no auth header answers 200 (401/403 or a `WWW-Authenticate`
  challenge is a rejection)
- the response is JSON and under 32 KB
- `parsePath` is the committable subset — `$.a.b`, `$.a[0].b`, `$['a']` — no
  wildcards, filters or recursive descent, which could select more than one node
- the path resolves to a bare decimal number, not an object, array, boolean,
  null or free text
- `valueScale` holds the reading with room to spare — the program rejects excess
  precision rather than truncating, and attested precision varies per reading

These are the constraints of Primus zkTLS in proxy-TLS mode. A rule that fails
any of them cannot be proven later.

## Deploy

```bash
cd infra/ai-drafter
npx wrangler secret put GEMINI_API_KEY      # paste the key; it never enters git
npx wrangler deploy
curl https://soo-ai-drafter.<subdomain>.workers.dev/health
```

Locally (`workerd` may reject a compatibility date newer than its build):

```bash
npx wrangler dev --compatibility-date 2026-05-07
```

## Use

```bash
curl -X POST https://soo-ai-drafter.<subdomain>.workers.dev/draft \
  -H 'content-type: application/json' \
  -d '{"question":"Will BTC be above $90,000 on December 31?"}'
```

```json
{"candidates":[{"url":"https://api.coinbase.com/v2/prices/BTC-USD/spot",
  "parsePath":"$.data.amount","comparator":"gt","threshold":"90000",
  "valueScale":8,"reading":"77220.245",
  "rationale":"resolves YES if Coinbase spot BTC/USD is above 90,000 at the deadline",
  "confidence":0.95}]}
```

Pick a candidate, check its `rationale` against the question, and pass
`url` + `parsePath` into market creation. The same pair then goes into
`infra/zk-resolver/markets.json`, which is where the resolver reads the preimage
the chain cannot give back.

## Tests

```bash
npm test              # everything
npm run test:unit     # no network, no key — stubbed model and stubbed fetch
npm run test:integration   # network, still no key: validates api.coinbase.com live
```

The model is injected (`src/gemini.js` is one implementation of a
`propose({question, feedback, count})` seam), so the validation and retry path
runs end to end without a Gemini key.

## Rate limiting

Per-IP fixed window, `RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_SECONDS` in
`wrangler.toml` (default 12 / 10 min). It is an in-isolate `Map`: **best effort**,
since Cloudflare may run several isolates and each keeps its own counters. It
stops casual draining of the key, not a distributed attacker. Move the counter
to KV or a Durable Object if the ceiling has to be exact.
