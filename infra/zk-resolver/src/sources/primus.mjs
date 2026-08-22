// The PRIMUS attestation source: a real zkTLS attestation.
//
// # Who signs, and what that means for registration
//
// The appId/appSecret authenticate this service to Primus' quota service and
// sign the REQUEST. They do not sign the attestation. Every attestation Primus
// returns is signed by Primus' own global attestor:
//
//     0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6   (PADOADDRESS)
//
// So a market that is to be resolved by a real Primus attestation MUST have
// been registered with THAT address as its `attestor_evm`. Registering a
// market to any other address and then pointing this source at it produces
// `ZkAttestorMismatch` on chain, every time, with no way to fix it after the
// fact — `register_zk_adjudicator` writes the attestor once.
//
// `PADO_ATTESTOR` is exported so callers can assert this before spending a
// fee, and `preflight()` does exactly that.
//
// # Why this is a Node service and not a Cloudflare Worker
//
// `@primuslabs/zktls-core-sdk` cannot run on workerd. Its algorithm backend is
// either a native N-API addon (`build/Release/primus-zktls-native.node`, built
// from `binding.gyp` by an npm `install` hook) or an emscripten pthreads WASM
// build whose glue requires `worker_threads`, `fs.readFileSync`, dynamic
// `eval`-based `importScripts` and `SharedArrayBuffer`. It also assigns
// `global.WebSocket = require('ws')` at module load, and `ws` is built on node
// `net` sockets. None of that exists under `nodejs_compat`, and workerd
// forbids dynamic code generation outright. See README for the full evidence.

import { hex, recoverAttestor, encodeAttestation } from "../evm.mjs";
import { fetchFeedValue, toFixedPoint } from "../feed.mjs";

/** Primus' global attestor. Every real attestation recovers to this address. */
export const PADO_ATTESTOR = "0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6";

/**
 * Refuses a market whose registered attestor is not Primus' attestor.
 *
 * Cheap, local, and definitive — it saves a two-minute attestation and a
 * transaction fee on a market that could never accept the result. Standalone
 * so `--plan` can run it without Primus credentials configured.
 */
export function primusPreflight({ market }) {
  const registered = `0x${hex(market.entry.attestorEvm)}`;
  if (registered.toLowerCase() !== PADO_ATTESTOR.toLowerCase()) {
    return {
      ok: false,
      detail:
        `market is registered to attestor ${registered}, but every Primus attestation is ` +
        `signed by ${PADO_ATTESTOR}. This market cannot be resolved by the primus source; ` +
        `it was registered for a different (probably fixture) attestor.`,
    };
  }
  return { ok: true };
}

/**
 * An attestation source backed by the Primus zkTLS network.
 *
 * The SDK is loaded lazily, on first use, by `createPrimusClient`.
 */
/**
 * Loads the SDK and returns an initialised client.
 *
 * Lazy for two reasons that both still hold: fixture mode must not require the
 * package to be installed at all, and its module top-level has side effects
 * (it overwrites `global.WebSocket`) that should not happen in a process that
 * will never use it.
 */
async function createPrimusClient({ appId, appSecret }) {
  let PrimusCoreTLS;
  try {
    ({ PrimusCoreTLS } = await import("@primuslabs/zktls-core-sdk"));
  } catch (err) {
    throw new Error(
      `cannot load @primuslabs/zktls-core-sdk: ${err.message}\n` +
        `Install it with \`npm install\` in infra/zk-resolver/. It builds a native addon ` +
        `on macOS arm64 and Ubuntu, and falls back to a WASM backend elsewhere; either way ` +
        `it needs a real Node runtime.`,
    );
  }
  const client = new PrimusCoreTLS();
  // Returns a string/boolean status rather than throwing on a bad appId, so
  // the result is checked rather than assumed.
  const status = await client.init(appId, appSecret);
  if (status === false) {
    throw new Error("PrimusCoreTLS.init returned false — check PRIMUS_APP_ID/PRIMUS_APP_SECRET");
  }
  return client;
}

/**
 * A market-free attestation of one `(url, parsePath)` pair.
 *
 * The resolution loop always attests a rule the chain already committed to.
 * `/attest-preview` asks the opposite question — CAN this rule be attested,
 * before any market exists to commit it — so it needs the same
 * `startAttestation` + `verifyAttestation` round trip with no market to read a
 * value scale or a registered attestor from. Everything that decides whether
 * Primus can sign a reading (auth, response size, cipher, proxy behaviour) is
 * exercised here exactly as it is on the resolution path; only the on-chain
 * bookkeeping is absent.
 *
 * One call is one unit of Primus quota. Callers rate-limit; this does not.
 */
export function primusPreviewer({ appId, appSecret, timeoutMs = 120_000 }) {
  if (!appId || !appSecret) {
    throw new Error(
      "PRIMUS_APP_ID and PRIMUS_APP_SECRET must both be set to request a Primus attestation",
    );
  }

  let client = null;

  return {
    attestorEvm: PADO_ATTESTOR,

    async attest({ url, parsePath, keyName, method = "GET", header = {}, body = "" }) {
      if (!client) client = await createPrimusClient({ appId, appSecret });

      const params = client.generateRequestParams({ url, method, header, body }, [
        { keyName, parseType: "", parsePath },
      ]);
      const startedAt = Date.now();
      const attestation = await client.startAttestation(params, timeoutMs);
      const elapsedMs = Date.now() - startedAt;

      // Primus' own verification recovers the signature against PADOADDRESS.
      if (!client.verifyAttestation(attestation)) {
        throw Object.assign(new Error("Primus verifyAttestation returned false"), {
          previewReason: "attestor",
        });
      }
      // And independently, with the same encoder the PROGRAM uses. The two
      // agreeing is what makes `ok: true` mean the market would verify.
      const attestorAddress = `0x${hex(recoverAttestor(attestation))}`;
      if (attestorAddress.toLowerCase() !== PADO_ATTESTOR.toLowerCase()) {
        throw Object.assign(
          new Error(
            `attestation recovered to ${attestorAddress}, not Primus' attestor ${PADO_ATTESTOR}`,
          ),
          { previewReason: "attestor" },
        );
      }

      let parsed;
      try {
        parsed = JSON.parse(attestation.data);
      } catch {
        throw Object.assign(
          new Error(`attested data is not JSON: ${JSON.stringify(attestation.data)}`),
          { previewReason: "response" },
        );
      }
      const raw = parsed?.[keyName];
      if (raw === undefined || raw === null || typeof raw === "object") {
        throw Object.assign(
          new Error(
            `attested data ${JSON.stringify(attestation.data)} carries no scalar "${keyName}"`,
          ),
          { previewReason: "response" },
        );
      }

      return {
        attestation,
        // Verified equal above, re-spelled in the checksummed form the market
        // registers and the README quotes, so a human can compare it by eye.
        attestorAddress: PADO_ATTESTOR,
        attestedValue: String(raw),
        elapsedMs,
        digest: `0x${hex(encodeAttestation(attestation))}`,
        attestedAt: Number(attestation.timestamp),
      };
    },
  };
}

export function primusSource({ appId, appSecret, timeoutMs = 120_000 }) {
  if (!appId || !appSecret) {
    throw new Error(
      "PRIMUS_APP_ID and PRIMUS_APP_SECRET must both be set to use the primus attestation source",
    );
  }

  let client = null;

  async function init() {
    if (client) return client;
    client = await createPrimusClient({ appId, appSecret });
    return client;
  }

  return {
    name: "primus",
    attestorEvm: PADO_ATTESTOR,

    preflight: primusPreflight,

    /**
     * Requests an attestation over the market's committed endpoint and field.
     *
     * `generateRequestParams` takes the request and the response resolves; the
     * resolves' `parsePath` and the request's `url` are precisely what the
     * on-chain `rule_hash` commits to, so they are taken from the registry
     * entry that was already verified against the chain — never re-derived
     * here, where a divergence would be invisible until the chain rejected it.
     */
    async attest({ entry, market }) {
      const zk = await init();

      const request = {
        url: entry.url,
        method: entry.method,
        header: JSON.parse(entry.header || "{}"),
        body: entry.body || "",
      };
      const responseResolves = [
        {
          keyName: entry.keyName,
          parseType: entry.parseType,
          parsePath: entry.parsePath,
        },
      ];

      const params = zk.generateRequestParams(request, responseResolves);
      const attestation = await zk.startAttestation(params, timeoutMs);

      // Primus' own verification: recovers the signature against PADOADDRESS.
      if (!zk.verifyAttestation(attestation)) {
        throw new Error("Primus verifyAttestation failed — refusing to submit");
      }

      // And independently, with the same encoder the PROGRAM uses. Primus'
      // check and this one can only disagree if the SDK's encoding has drifted
      // from `zk/primus.rs`, which is exactly the case worth catching before a
      // fee is spent.
      const recovered = `0x${hex(recoverAttestor(attestation))}`;
      if (recovered.toLowerCase() !== PADO_ATTESTOR.toLowerCase()) {
        throw new Error(
          `local recovery got ${recovered}, expected ${PADO_ATTESTOR} — ` +
            `the attestation encoding this resolver shares with the program disagrees ` +
            `with the one Primus signed. Refusing to submit.`,
        );
      }
      // Digest computed for the log trail; a submission that later fails on
      // chain can be matched against it.
      const digest = `0x${hex(encodeAttestation(attestation))}`;

      // What Primus actually attested, parsed the way the program will parse
      // it. This is the number that decides the market.
      let observed = null;
      try {
        const parsed = JSON.parse(attestation.data);
        const raw = String(parsed[entry.keyName]);
        observed = {
          raw,
          scaled: toFixedPoint(raw, market.entry.valueScale),
          at: Number(attestation.timestamp),
          digest,
        };
      } catch (err) {
        throw new Error(
          `attestation data ${JSON.stringify(attestation.data)} has no usable ` +
            `"${entry.keyName}" field: ${err.message}`,
        );
      }

      return { attestation, observed };
    },

    /**
     * A plain fetch of the same endpoint, for the log only.
     *
     * Divergence between this and the attested value is normal — they are two
     * readings at two moments — but a large or persistent gap is worth seeing,
     * so the caller logs both. It never influences what is submitted.
     */
    async observeUnattested(entry) {
      try {
        return (await fetchFeedValue(entry)).raw;
      } catch {
        return null;
      }
    },
  };
}
