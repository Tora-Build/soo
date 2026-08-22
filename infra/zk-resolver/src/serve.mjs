// The proof endpoint: can Primus actually attest this rule?
//
//     node src/index.mjs --serve --port 8787
//
// A market commits `rule_hash = H(url, parsePath)` at creation and can never
// change it. A rule that fetches perfectly in a browser preview can still be
// UNATTESTABLE — the endpoint needs auth Primus does not carry, the response
// is larger than the algorithm service will process, the TLS cipher is outside
// what the MPC/proxy session negotiates, the origin treats the proxy
// differently from a browser. None of that shows up in a fetch. It shows up
// the first time the resolver tries to close the market, which is months after
// the rule became immutable.
//
// So this endpoint answers the only question that matters before creation, and
// it answers it the expensive way: by running a REAL `startAttestation` and
// verifying the signature locally. `ok: true` means Primus signed a reading of
// that exact URL and this repo's encoder — the mirror of `zk/primus.rs` —
// recovered Primus' global attestor from it.
//
// ## Contract
//
//   POST /attest-preview   { url, parsePath }
//     200 { ok: true,  attestedValue, decimals, attestorAddress, elapsedMs,
//           attestedAt, digest, quotaRemaining? }
//     200 { ok: false, reason, detail }      the rule cannot be attested
//     400 { ok: false, reason: "bad_request", detail }
//     401 { ok: false, reason: "unauthorized", detail }
//     429 { ok: false, reason: "rate_limited", detail, retryAfterMs }
//   GET  /health           200 { ok: true, primus, budget }
//
// A `reason` is a diagnosis, never a stack trace. It names which stage failed:
//
//   fetch     the endpoint did not answer with usable JSON at all — dead host,
//             non-2xx, auth it does not have. Caught by a plain fetch BEFORE
//             any quota is spent.
//   response  the response arrived but does not reduce to one value at that
//             path — from the free pre-fetch, or from the attested data if the
//             session got that far.
//   proxy     the MPC-TLS / proxy-TLS session itself failed: handshake, cipher,
//             the algorithm websocket, or the two-minute timeout.
//   quota     Primus refused the request — credentials or exhausted quota.
//   attestor  a signature that does not recover to Primus' global attestor.
//             The market would reject it on chain with ZkAttestorMismatch.
//
// ## Quota
//
// One preview that reaches Primus costs exactly ONE attestation unit, whether
// it succeeds or the session fails. A `bad_request`, a `rate_limited`, and the
// `fetch` / `response` refusals raised by the free pre-fetch all cost ZERO —
// the pre-fetch runs first precisely so a dead endpoint or a wrong path never
// reaches Primus. The founder's balance is small, so the budget below is
// deliberately mean and shared across the whole process, not per client.

import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";

import { SERVICE_ROOT } from "./deps.mjs";
import { fetchFeedValue } from "./feed.mjs";
import { PADO_ATTESTOR, primusPreviewer } from "./sources/primus.mjs";

/** Largest request body worth reading. A rule is a url and a path. */
const MAX_BODY_BYTES = 8 * 1024;

/** Longest url the program's `zk/primus.rs` will hold in a digest. */
const MAX_URL_BYTES = 512;

// ── The quota budget ───────────────────────────────────────────────────────

/**
 * A spend ceiling on Primus quota, shared by every caller of this process.
 *
 * Three limits, because they stop three different mistakes:
 *
 *   - `minIntervalMs` stops a UI that fires on every keystroke;
 *   - `maxInFlight` (always 1) stops a page that opens ten previews at once;
 *   - `windowMax` over `windowMs` stops a script that patiently drains the
 *     balance overnight at one call per interval.
 *
 * The window is PERSISTED, so restarting the service does not hand a caller a
 * fresh allowance. Losing the file only loses the memory of past spend, which
 * is why it is written after every charge rather than on exit.
 */
export class QuotaBudget {
  constructor({
    minIntervalMs = 15_000,
    windowMs = 24 * 60 * 60 * 1000,
    windowMax = 20,
    path = null,
    now = () => Date.now(),
  } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.windowMs = windowMs;
    this.windowMax = windowMax;
    this.path = path;
    this.now = now;
    this.inFlight = 0;
    this.spends = this.#load();
  }

  #load() {
    if (!this.path) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(parsed?.spends) ? parsed.spends.filter(Number.isFinite) : [];
    } catch {
      return [];
    }
  }

  #save() {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify({ spends: this.spends }, null, 2));
    } catch {
      // A budget that cannot persist still limits this process. Failing the
      // request over it would take the endpoint down for a disk problem.
    }
  }

  #prune(now) {
    this.spends = this.spends.filter((t) => now - t < this.windowMs);
  }

  /** `{ ok }`, or `{ ok: false, detail, retryAfterMs }`. Charges nothing. */
  check() {
    const now = this.now();
    this.#prune(now);
    if (this.inFlight >= 1) {
      return {
        ok: false,
        detail: "another attestation is already running; previews are serialised so one page cannot spend the balance in parallel",
        retryAfterMs: this.minIntervalMs,
      };
    }
    const last = this.spends[this.spends.length - 1];
    if (last !== undefined && now - last < this.minIntervalMs) {
      const retryAfterMs = this.minIntervalMs - (now - last);
      return {
        ok: false,
        detail: `previews are limited to one per ${Math.round(this.minIntervalMs / 1000)}s; each one spends a unit of Primus quota`,
        retryAfterMs,
      };
    }
    if (this.spends.length >= this.windowMax) {
      const oldest = this.spends[0];
      return {
        ok: false,
        detail: `the ${Math.round(this.windowMs / 3_600_000)}h preview budget of ${this.windowMax} attestations is spent`,
        retryAfterMs: this.windowMs - (now - oldest),
      };
    }
    return { ok: true };
  }

  /** Records one unit spent. Called immediately before `startAttestation`. */
  charge() {
    const now = this.now();
    this.#prune(now);
    this.spends.push(now);
    this.#save();
  }

  /** How many of the window's units are still available. */
  remaining() {
    this.#prune(this.now());
    return Math.max(0, this.windowMax - this.spends.length);
  }
}

// ── Request shape ──────────────────────────────────────────────────────────

/**
 * Derives the attestation's `keyName` from the parse path's last segment.
 *
 * Primus keys its signed `data` object by `keyName`, and the resolver reads it
 * back by the same name. Nothing on chain commits to it — `rule_hash` covers
 * the url and the path only — so the preview picks one rather than asking for
 * a field the creator has no way to reason about.
 */
export function keyNameFor(parsePath) {
  const segments = String(parsePath).match(/[A-Za-z_][A-Za-z0-9_-]*/g);
  const last = segments?.[segments.length - 1];
  return last && last !== "$" ? last : "value";
}

/** Validates the body. Returns `{ ok, url, parsePath }` or `{ ok: false, detail }`. */
export function validatePreviewRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, detail: "body must be a JSON object with url and parsePath" };
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const parsePath = typeof body.parsePath === "string" ? body.parsePath.trim() : "";
  if (!url) return { ok: false, detail: "url is required" };
  if (!parsePath) return { ok: false, detail: "parsePath is required" };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, detail: `url ${JSON.stringify(url)} is not a URL` };
  }
  // http is refused rather than attempted: there is no TLS session to attest.
  if (parsed.protocol !== "https:") {
    return { ok: false, detail: "url must be https — a zkTLS attestation observes a TLS session" };
  }
  if (Buffer.byteLength(url, "utf8") > MAX_URL_BYTES) {
    return {
      ok: false,
      detail: `url is ${Buffer.byteLength(url, "utf8")} bytes, over the ${MAX_URL_BYTES} the program's digest holds`,
    };
  }
  if (!parsePath.startsWith("$")) {
    return { ok: false, detail: 'parsePath must start with "$" — for example $.data.amount' };
  }
  if (/[*?]|\.\./.test(parsePath)) {
    return {
      ok: false,
      detail: `parsePath ${parsePath} uses wildcard or recursive syntax, which can select more than one value; a market rule must name exactly one field`,
    };
  }
  return { ok: true, url, parsePath };
}

/** Fractional digits in a decimal string. */
export function decimalPlaces(value) {
  const frac = String(value).split(".")[1];
  return frac ? frac.length : 0;
}

/**
 * Maps a thrown error onto one of the endpoint's reasons.
 *
 * The caller is a creator deciding whether to commit a rule forever, so the
 * answer has to be a stage — "Primus could not run the session" is actionable,
 * `TypeError: Cannot read properties of undefined` is not.
 */
export function classifyPrimusError(err) {
  if (err?.previewReason) return err.previewReason;
  const text = `${err?.code ?? ""} ${err?.message ?? err ?? ""}`.toLowerCase();
  if (/quota|credit|balance|limit exceeded|too many requests|app ?id|app ?secret|unauthor|forbidden|signature verif/.test(text)) {
    return "quota";
  }
  if (/parse|json|field|keyname|resolve|empty data|no data/.test(text)) return "response";
  return "proxy";
}

/**
 * The same question for the free pre-fetch: did the REQUEST fail, or did the
 * response arrive and fail to yield a value?
 *
 * Worth splitting even though neither costs quota, because they are different
 * repairs. `fetch` means the url or its auth is wrong; `response` means the
 * url is right and the path is not.
 */
export function classifyPrefetchError(err) {
  const text = `${err?.message ?? err ?? ""}`;
  if (/parsePath|expected a string or number|is not a supported path/.test(text)) {
    return "response";
  }
  return "fetch";
}

/** Human wording for each reason, ahead of the raw detail. */
const REASON_HINT = {
  fetch: "the endpoint itself did not return usable JSON, so Primus was never asked (no quota spent)",
  response: "Primus reached the endpoint, but the response could not be reduced to one value at that path",
  proxy: "Primus could not complete the attested TLS session with this endpoint — auth, response size, cipher or proxy behaviour",
  quota: "Primus refused the request: credentials or exhausted quota",
  attestor: "the attestation did not recover to Primus' global attestor, so a market would reject it on chain",
};

/** The pre-fetch stage says its own name, and that it spent nothing. */
const PREFETCH_HINT = {
  fetch: "the endpoint did not answer with usable JSON, so Primus was never asked (no quota spent)",
  response: "the endpoint answered, but that path does not name one value in it, so Primus was never asked (no quota spent)",
};

// ── The handler ────────────────────────────────────────────────────────────

/**
 * Builds the `/attest-preview` handler.
 *
 * `attest` is injected so the route can be tested without touching Primus —
 * the tests must not spend the founder's quota to prove that a missing field
 * is a 400.
 */
export function createPreviewHandler({ attest, budget, prefetch = fetchFeedValue }) {
  return async function handlePreview(body) {
    const valid = validatePreviewRequest(body);
    if (!valid.ok) {
      return { status: 400, body: { ok: false, reason: "bad_request", detail: valid.detail } };
    }
    const { url, parsePath } = valid;
    const keyName = keyNameFor(parsePath);

    const allowed = budget.check();
    if (!allowed.ok) {
      return {
        status: 429,
        body: {
          ok: false,
          reason: "rate_limited",
          detail: allowed.detail,
          retryAfterMs: Math.max(0, Math.round(allowed.retryAfterMs ?? 0)),
        },
      };
    }

    // Free triage first. A dead url, a 403, a body that is not JSON, a path
    // that resolves to nothing — all of it is knowable without Primus, and
    // spending a unit to learn it would be the one thing this endpoint must
    // not do.
    try {
      await prefetch({ url, parsePath, method: "GET", header: "", body: "" });
    } catch (err) {
      const reason = classifyPrefetchError(err);
      return {
        status: 200,
        body: {
          ok: false,
          reason,
          detail: `${PREFETCH_HINT[reason]}: ${err?.message ?? err}`,
        },
      };
    }

    budget.inFlight += 1;
    budget.charge();
    try {
      const result = await attest({ url, parsePath, keyName });
      return {
        status: 200,
        body: {
          ok: true,
          attestedValue: result.attestedValue,
          decimals: decimalPlaces(result.attestedValue),
          attestorAddress: result.attestorAddress,
          elapsedMs: result.elapsedMs,
          attestedAt: result.attestedAt ?? null,
          digest: result.digest ?? null,
          quotaRemaining: budget.remaining(),
        },
      };
    } catch (err) {
      const reason = classifyPrimusError(err);
      return {
        status: 200,
        body: {
          ok: false,
          reason,
          detail: `${REASON_HINT[reason] ?? "the attestation failed"}: ${err?.message ?? err}`,
          quotaRemaining: budget.remaining(),
        },
      };
    } finally {
      budget.inFlight -= 1;
    }
  };
}

// ── Transport ──────────────────────────────────────────────────────────────

/** Constant-time bearer-token comparison. */
function tokenMatches(expected, presented) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented ?? "", "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        rej(new Error(`request body over ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rej);
  });
}

/**
 * The HTTP surface.
 *
 * `token` is the shared secret from `RESOLVER_API_TOKEN`. When it is unset the
 * endpoint is open, which is only safe because the default bind is loopback —
 * `startPreviewServer` says so out loud when both are true.
 */
export function createPreviewServer({ handlePreview, token = null, budget, allowedOrigin = "*" }) {
  return createServer((req, res) => {
    const send = (status, payload) => {
      const json = JSON.stringify(payload);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(json),
        "access-control-allow-origin": allowedOrigin,
        "access-control-allow-headers": "content-type, authorization",
        "access-control-allow-methods": "POST, GET, OPTIONS",
        "cache-control": "no-store",
      });
      res.end(json);
    };

    const path = (req.url ?? "/").split("?")[0];

    if (req.method === "OPTIONS") {
      send(204, {});
      return;
    }

    if (req.method === "GET" && path === "/health") {
      send(200, {
        ok: true,
        service: "zk-resolver",
        attestor: PADO_ATTESTOR,
        quotaRemaining: budget.remaining(),
        tokenRequired: Boolean(token),
      });
      return;
    }

    if (path !== "/attest-preview") {
      send(404, { ok: false, reason: "not_found", detail: `no route ${req.method} ${path}` });
      return;
    }
    if (req.method !== "POST") {
      send(405, { ok: false, reason: "method_not_allowed", detail: "POST /attest-preview" });
      return;
    }

    // Authorisation precedes body parsing: an unauthorised caller learns
    // nothing about what the endpoint would have accepted.
    if (token) {
      const header = req.headers.authorization ?? "";
      const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
      const presented = bearer || String(req.headers["x-resolver-token"] ?? "");
      if (!tokenMatches(token, presented)) {
        send(401, {
          ok: false,
          reason: "unauthorized",
          detail: "RESOLVER_API_TOKEN is configured; send it as `Authorization: Bearer <token>`",
        });
        return;
      }
    }

    readBody(req)
      .then((text) => {
        let parsed;
        try {
          parsed = text.trim() ? JSON.parse(text) : {};
        } catch {
          send(400, { ok: false, reason: "bad_request", detail: "body is not valid JSON" });
          return null;
        }
        return handlePreview(parsed).then((r) => send(r.status, r.body));
      })
      .catch((err) => {
        send(400, { ok: false, reason: "bad_request", detail: err?.message ?? String(err) });
      });
  });
}

/**
 * Wires config to a listening server. `--serve`.
 *
 * Binds loopback unless `RESOLVER_BIND` says otherwise, because the process
 * holding the Primus credentials should not be reachable from a network by
 * default. Binding wide without a token is refused rather than warned about:
 * that combination is an open faucet on the founder's balance.
 */
export async function startPreviewServer({ config, env, args, log, warn }) {
  const host = args.host ?? env.RESOLVER_BIND ?? "127.0.0.1";
  const port = Number(args.port ?? env.RESOLVER_PORT ?? 8787);
  const token = env.RESOLVER_API_TOKEN || null;

  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && !token) {
    throw new Error(
      `refusing to bind ${host} without RESOLVER_API_TOKEN — every preview spends a unit of ` +
        `Primus quota, and an unauthenticated endpoint on a routable address is a drain on it`,
    );
  }

  const budget = new QuotaBudget({
    minIntervalMs: Number(env.RESOLVER_PREVIEW_MIN_INTERVAL_MS ?? 15_000),
    windowMs: Number(env.RESOLVER_PREVIEW_WINDOW_MS ?? 24 * 60 * 60 * 1000),
    windowMax: Number(env.RESOLVER_PREVIEW_WINDOW_MAX ?? 20),
    path: env.RESOLVER_PREVIEW_STATE_PATH || resolve(SERVICE_ROOT, ".state", "preview-quota.json"),
  });

  const previewer = primusPreviewer({
    appId: config.primusAppId,
    appSecret: config.primusAppSecret,
    timeoutMs: config.primusTimeoutMs,
  });

  const handlePreview = createPreviewHandler({
    attest: (rule) => previewer.attest(rule),
    budget,
  });

  const server = createPreviewServer({
    handlePreview,
    token,
    budget,
    allowedOrigin: env.RESOLVER_ALLOWED_ORIGIN ?? "*",
  });

  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, res);
  });

  log(`serving POST /attest-preview on http://${host}:${port}`);
  log(`attestor: ${PADO_ATTESTOR}`);
  log(
    `budget:   1 attestation per ${Math.round(budget.minIntervalMs / 1000)}s, ` +
      `${budget.remaining()}/${budget.windowMax} left in the window (1 unit of Primus quota each)`,
  );
  if (!token) {
    warn("RESOLVER_API_TOKEN is unset — the endpoint is open to anything that can reach this host");
  }
  return server;
}
