#!/usr/bin/env node
// A standalone Primus attestation, printed in full.
//
// This is the ground truth the rest of the zkTLS path is reconciled against:
// one real `startAttestation` over a public no-auth JSON endpoint, with every
// field of the returned object dumped verbatim. It touches no chain and needs
// no Solana key — only PRIMUS_APP_ID / PRIMUS_APP_SECRET.
//
//     node scripts/primus-probe.mjs
//     node scripts/primus-probe.mjs --url <url> --parse-path '$.a.b' --key-name b
//
// What it reports, beyond the raw object:
//
//   - the exact `request` Primus signed, so header/method/body rewrites the
//     SDK performs on the way in (`assemblyParams` appends
//     `Accept-Encoding: identity`) are visible rather than guessed;
//   - how many `reponseResolve` entries came back, and whether `parseType`
//     survived the round trip;
//   - `timestamp` in both interpretations, so seconds-vs-milliseconds is
//     settled by looking at it;
//   - the digest recomputed by THIS repo's encoder (`src/evm.mjs`, the mirror
//     of `zk/primus.rs`) and the address it recovers, next to Primus' own
//     `verifyAttestation`. Those two agreeing is the whole question.
//
// Every attestation costs quota, so this script requests exactly one.

import { inspect } from "node:util";

import { loadEnv } from "../src/config.mjs";
import { encodeAttestation, hex, recoverAttestor } from "../src/evm.mjs";

const PADO_ATTESTOR = "0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6";

const DEFAULTS = {
  url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
  parsePath: "$.data.amount",
  keyName: "amount",
  parseType: "string",
  method: "GET",
  header: '{"accept":"application/json"}',
  body: "",
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    if (a === "--url") out.url = take();
    else if (a === "--parse-path") out.parsePath = take();
    else if (a === "--key-name") out.keyName = take();
    else if (a === "--parse-type") out.parseType = take();
    else if (a === "--method") out.method = take().toUpperCase();
    else if (a === "--header") out.header = take();
    else if (a === "--body") out.body = take();
    else if (a === "--timeout") out.timeoutMs = Number(take());
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const line = (s = "") => process.stdout.write(`${s}\n`);
const dump = (label, value) =>
  line(`${label}: ${inspect(value, { depth: null, maxStringLength: null, colors: false })}`);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const appId = env.PRIMUS_APP_ID;
  const appSecret = env.PRIMUS_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("PRIMUS_APP_ID and PRIMUS_APP_SECRET must both be set");
  }
  const timeoutMs = opts.timeoutMs ?? Number(env.PRIMUS_TIMEOUT_MS ?? 120_000);

  line("=== probe configuration ===");
  line(`appId:     ${appId}`);
  line(`url:       ${opts.url}`);
  line(`parsePath: ${opts.parsePath}`);
  line(`keyName:   ${opts.keyName}`);
  line(`parseType: ${opts.parseType}`);
  line(`method:    ${opts.method}`);
  line(`header:    ${opts.header}`);
  line(`body:      ${JSON.stringify(opts.body)}`);
  line(`timeout:   ${timeoutMs}ms`);
  line();

  // A plain fetch first: it costs no quota and tells us what the endpoint's
  // precision actually is, which decides the market's `value_scale`.
  line("=== unattested fetch (no quota spent) ===");
  try {
    const res = await fetch(opts.url, { headers: { accept: "application/json" } });
    const body = await res.json();
    line(`HTTP ${res.status}`);
    dump("body", body);
  } catch (err) {
    line(`fetch failed: ${err.message}`);
  }
  line();

  const { PrimusCoreTLS } = await import("@primuslabs/zktls-core-sdk");
  const zk = new PrimusCoreTLS();
  line("=== init ===");
  const status = await zk.init(appId, appSecret);
  line(`init returned: ${inspect(status)}`);
  line(`algoUrls: ${zk.algoUrls?.toJsonString?.() ?? inspect(zk.algoUrls)}`);
  line();

  const request = {
    url: opts.url,
    method: opts.method,
    header: JSON.parse(opts.header || "{}"),
    body: opts.body,
  };
  const responseResolves = [
    { keyName: opts.keyName, parseType: opts.parseType, parsePath: opts.parsePath },
  ];

  line("=== generateRequestParams ===");
  const params = zk.generateRequestParams(request, responseResolves);
  dump("AttRequest", JSON.parse(params.toJsonString()));
  line();

  line("=== startAttestation (one quota unit) ===");
  const startedAt = Date.now();
  let attestation;
  try {
    attestation = await zk.startAttestation(params, timeoutMs);
  } catch (err) {
    line(`FAILED after ${Date.now() - startedAt}ms`);
    dump("error", err);
    if (err?.toJSON) dump("error.toJSON()", err.toJSON());
    throw err;
  }
  line(`succeeded in ${Date.now() - startedAt}ms`);
  line();

  line("=== raw attestation ===");
  dump("attestation", attestation);
  line();
  line("--- JSON ---");
  line(JSON.stringify(attestation, null, 2));
  line();

  line("=== field-by-field ===");
  line(`top-level keys:      ${Object.keys(attestation).join(", ")}`);
  line(`recipient:           ${attestation.recipient}`);
  dump("request", attestation.request);
  line(`request is array:    ${Array.isArray(attestation.request)}`);
  const resolves = attestation.reponseResolve ?? attestation.responseResolve;
  line(`resolve key spelled: ${"reponseResolve" in attestation ? "reponseResolve" : "responseResolve"}`);
  line(`resolve count:       ${Array.isArray(resolves) ? resolves.length : "not an array"}`);
  dump("reponseResolve", resolves);
  line(`data (raw):          ${JSON.stringify(attestation.data)}`);
  line(`data type:           ${typeof attestation.data}`);
  try {
    const parsed = JSON.parse(attestation.data);
    line(`data parsed keys:    ${Object.keys(parsed).join(", ")}`);
    line(`data["${opts.keyName}"]: ${JSON.stringify(parsed[opts.keyName])}`);
    const v = String(parsed[opts.keyName]);
    const frac = v.includes(".") ? v.split(".")[1].length : 0;
    line(`decimal places:      ${frac}`);
  } catch {
    line("data is not a JSON object — it is a bare token");
  }
  line(`attConditions:       ${JSON.stringify(attestation.attConditions)}`);
  line(`additionParams:      ${JSON.stringify(attestation.additionParams)}`);
  line(`timestamp:           ${attestation.timestamp} (${typeof attestation.timestamp})`);
  line(`  as seconds ->      ${new Date(Number(attestation.timestamp) * 1000).toISOString()}`);
  line(`  as millis   ->     ${new Date(Number(attestation.timestamp)).toISOString()}`);
  line(`  now         ->     ${new Date().toISOString()}`);
  dump("attestors", attestation.attestors);
  dump("signatures", attestation.signatures);
  line(`signature length:    ${(attestation.signatures?.[0] ?? "").replace(/^0x/, "").length / 2} bytes`);
  line(`signature v:         0x${(attestation.signatures?.[0] ?? "").slice(-2)}`);
  line();

  line("=== verification ===");
  let primusOk = null;
  try {
    primusOk = zk.verifyAttestation(attestation);
  } catch (err) {
    line(`Primus verifyAttestation threw: ${err.message}`);
  }
  line(`Primus verifyAttestation: ${primusOk}`);

  try {
    const digest = `0x${hex(encodeAttestation(attestation))}`;
    line(`local digest (zk/primus.rs mirror): ${digest}`);
    const recovered = `0x${hex(recoverAttestor(attestation))}`;
    line(`local recovered signer:             ${recovered}`);
    line(
      `matches PADOADDRESS ${PADO_ATTESTOR}: ` +
        `${recovered.toLowerCase() === PADO_ATTESTOR.toLowerCase()}`,
    );
  } catch (err) {
    line(`local encoding/recovery FAILED: ${err.message}`);
    line(err.stack ?? "");
  }
  line();

  line("=== on-chain field size budget (zk/primus.rs caps) ===");
  const caps = {
    "request.url": [attestation.request?.url ?? "", 512],
    "request.header": [attestation.request?.header ?? "", 1024],
    "request.method": [attestation.request?.method ?? "", 16],
    "request.body": [attestation.request?.body ?? "", 1024],
    data: [attestation.data ?? "", 512],
    attConditions: [attestation.attConditions ?? "", 1024],
    additionParams: [attestation.additionParams ?? "", 512],
  };
  for (const [name, [value, cap]] of Object.entries(caps)) {
    const len = Buffer.byteLength(String(value), "utf8");
    line(`${name.padEnd(16)} ${String(len).padStart(5)} / ${cap}  ${len <= cap ? "ok" : "OVER"}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
