#!/usr/bin/env node
// The zkTLS resolution service.
//
// One pass over the registry: for every watched market, ask the chain whether
// it is due and un-attested, verify the local rule against the market's
// on-chain commitment, get an attestation, and submit `attest_outcome_zk`.
//
//     node src/index.mjs --once            one pass, exit (what cron runs)
//     node src/index.mjs --watch           loop every RESOLVER_INTERVAL_MS
//     node src/index.mjs --once --plan     read-only: what it WOULD do
//     node src/index.mjs --review          Gemini rule review (advisory, off-path)
//
// `attest_outcome_zk` is permissionless — the attestor's signature is the
// authority — so RESOLVER_KEYPAIR is a funded fee payer, not a privileged key.
// The one exception is `request_lock`, which IS signer-gated on the entry's
// authority; a market past its deadline but still Open can only be locked by
// that key, and the loop reports rather than pretends when it cannot.
//
// No emojis in output (project rule).

import { Chain, bs58Decode, describeError, sdk, sleep } from "./chain.mjs";
import { loadEnv, parseKeypair, resolveConfig } from "./config.mjs";
import {
  COMPARATOR_NAMES,
  COMPARATOR_SYMBOLS,
  fromFixedPoint,
  predictOutcome,
} from "./feed.mjs";
import { hex, selfTestEncoding } from "./evm.mjs";
import { loadRegistry, verifyRule } from "./registry.mjs";
import { ACTION, decideAction, outcomeName } from "./resolve.mjs";
import { fixtureSource } from "./sources/fixture.mjs";
import { PADO_ATTESTOR, primusPreflight, primusSource } from "./sources/primus.mjs";
import { Journal } from "./state.mjs";
import { runVoid } from "./void/run.mjs";

// ── Output ─────────────────────────────────────────────────────────────────

const log = (msg) => process.stdout.write(`[zk-resolver] ${msg}\n`);
const warn = (msg) => process.stderr.write(`[zk-resolver] WARN ${msg}\n`);
const errorOut = (msg) => process.stderr.write(`[zk-resolver] ERROR ${msg}\n`);

// ── CLI ────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = {
    once: false,
    watch: false,
    plan: false,
    review: false,
    source: "primus",
    envFile: null,
    only: null,
    // T* voiding (docs/design/t-star-voiding.md). `--void` computes the
    // entitlement tree; it PRINTS unless `--publish` is also given, because a
    // commitment is only disputable while the veto window is open and a human
    // should have seen the table before it lands.
    void: false,
    tStar: null,
    publish: false,
    out: null,
    maxSignatures: 20_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") args.once = true;
    else if (a === "--watch") args.watch = true;
    else if (a === "--plan" || a === "--dry-run") args.plan = true;
    else if (a === "--review") args.review = true;
    else if (a === "--source") args.source = argv[++i];
    else if (a.startsWith("--source=")) args.source = a.slice(9);
    else if (a === "--env-file") args.envFile = argv[++i];
    else if (a.startsWith("--env-file=")) args.envFile = a.slice(11);
    else if (a === "--void") args.void = true;
    else if (a === "--publish") args.publish = true;
    else if (a === "--t-star") args.tStar = argv[++i];
    else if (a.startsWith("--t-star=")) args.tStar = a.slice(9);
    else if (a === "--out") args.out = argv[++i];
    else if (a.startsWith("--out=")) args.out = a.slice(6);
    else if (a === "--max-signatures") args.maxSignatures = Number(argv[++i]);
    else if (a.startsWith("--max-signatures=")) args.maxSignatures = Number(a.slice(17));
    else if (a === "--only") args.only = argv[++i];
    else if (a.startsWith("--only=")) args.only = a.slice(7);
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.once && !args.watch && !args.review && !args.void) args.once = true;
  return args;
}

const USAGE = `
zk-resolver — submits attest_outcome_zk for zkTLS-adjudicated sooth_core markets

  --once             run one pass and exit (default; this is what cron runs)
  --watch            loop forever, RESOLVER_INTERVAL_MS between passes
  --plan             read chain state and report what would happen; submits nothing
  --review           ask Gemini to review each registry rule (advisory, never resolves)
  --source <name>    "primus" (default) or "fixture"
  --only <market>    restrict to one market pubkey
  --env-file <path>  load secrets from a dotenv file

T* voiding (docs/design/t-star-voiding.md):
  --void             compute the per-wallet entitlement tree and print it
  --t-star <v>       T*: unix seconds, or "auto" (the zkTLS attestation's own
                     signed timestamp, read from ZkOutcomeAttested)
  --publish          also submit publish_resolution_commitment (default: print only)
  --out <dir>        where the proof JSON is written (default .state/resolutions)
  --max-signatures   ceiling on the tape walk (default 20000)

Environment:
  SOLANA_RPC_URL         defaults to https://api.devnet.solana.com
  RESOLVER_KEYPAIR       funded fee payer: JSON byte array or base58 secret key
  PRIMUS_APP_ID          required for --source primus
  PRIMUS_APP_SECRET      required for --source primus
  GEMINI_API_KEY         optional, --review only
  RESOLVER_INTERVAL_MS   watch-mode interval (default 300000)
  RESOLVER_REGISTRY      path to markets.json
  RESOLVER_STATE_PATH    path to the journal
`;

// ── One market ─────────────────────────────────────────────────────────────

/**
 * Resolves a single market, or reports why it was not resolved.
 *
 * Returns a result record rather than throwing, so one bad market cannot end a
 * pass over the others — a resolver that stops at the first failure would let
 * a single misconfigured entry block every other market's settlement.
 */
export async function resolveMarket({ chain, entry, source, now, plan, journal }) {
  const tag = `${entry.label} ${entry.market}`;

  const chainState = await chain.readMarket(entry.market);

  let ruleCheck = null;
  if (chainState.exists) {
    ruleCheck = await verifyRule(entry, chainState.entry.ruleHash, sdk.computeRuleHash);
  }

  const canLock =
    chain.payer != null &&
    chainState.exists &&
    chainState.entry.authority?.equals?.(chain.payer.publicKey) === true;

  const decision = decideAction({ chainState, ruleCheck, now, canLock });

  if (decision.action === ACTION.REFUSE) {
    errorOut(`${tag}: REFUSED — ${decision.reason}`);
    return { market: entry.market, status: "refused", reason: decision.reason };
  }

  if (decision.action === ACTION.SKIP) {
    log(`${tag}: skip — ${decision.reason}`);
    return { market: entry.market, status: "skipped", reason: decision.reason };
  }

  // Everything below acts. Report the rule the chain holds, so the log shows
  // what this market actually asks rather than what the registry believes.
  const { comparator, valueScale, threshold } = chainState.entry;
  log(
    `${tag}: due — rule: value ${COMPARATOR_SYMBOLS[comparator] ?? COMPARATOR_NAMES[comparator]} ` +
      `${fromFixedPoint(threshold, valueScale)} (scale ${valueScale}), ` +
      `attestor 0x${hex(chainState.entry.attestorEvm)}`,
  );
  log(`${tag}: rule hash verified against the registry entry`);

  if (journal?.inBackoff(entry.market, now)) {
    const at = journal.retryAt(entry.market);
    log(`${tag}: skip — in backoff after ${journal.get(entry.market).failures} failures, retry at ${at}`);
    return { market: entry.market, status: "skipped", reason: "backoff" };
  }

  if (decision.action === ACTION.LOCK) {
    if (plan) {
      log(`${tag}: PLAN would request_lock (deadline passed, market Open)`);
      return { market: entry.market, status: "would-lock" };
    }
    const sig = await chain.requestLock(chainState.marketPk, chainState.entryPk);
    log(`${tag}: request_lock ${sig}`);
    // Re-read so this pass can go straight on to attesting.
    const relocked = await chain.readMarket(entry.market);
    chainState.market.lifecycle = relocked.market.lifecycle;
  }

  // A source may refuse a market it structurally cannot resolve — chiefly the
  // Primus source refusing a market registered to a non-Primus attestor.
  if (source.preflight) {
    const pre = source.preflight({ market: chainState, entry });
    if (!pre.ok) {
      errorOut(`${tag}: REFUSED — ${pre.detail}`);
      return { market: entry.market, status: "refused", reason: pre.detail };
    }
  }

  if (plan) {
    log(`${tag}: PLAN would request an attestation from "${source.name}" and submit attest_outcome_zk`);
    return { market: entry.market, status: "would-attest" };
  }

  let attested;
  try {
    attested = await source.attest({ entry, market: chainState });
  } catch (err) {
    journal?.recordFailure(entry.market, { error: err.message, at: now });
    errorOut(`${tag}: attestation failed — ${err.message}`);
    return { market: entry.market, status: "failed", reason: err.message };
  }

  const { attestation, observed } = attested;
  log(`${tag}: attested value ${observed.raw} at ${new Date(observed.at).toISOString()}`);

  // What the on-chain comparator implies. Logged only — the program recomputes
  // it from the signed value and its own stored rule, and that is what binds.
  const expected = predictOutcome(observed.scaled, comparator, threshold);
  log(
    `${tag}: expect ${observed.raw} ${COMPARATOR_SYMBOLS[comparator]} ` +
      `${fromFixedPoint(threshold, valueScale)} -> ${outcomeName(expected)}`,
  );

  let signature;
  try {
    signature = await chain.attestOutcomeZk(chainState.marketPk, attestation);
  } catch (err) {
    const detail = describeError(err);
    journal?.recordFailure(entry.market, { error: detail, at: now });
    errorOut(`${tag}: attest_outcome_zk rejected — ${detail}`);
    return { market: entry.market, status: "failed", reason: detail };
  }

  log(`${tag}: attest_outcome_zk ${signature}`);

  // Read back, so the log records what the CHAIN decided rather than what this
  // process predicted. A disagreement here means the resolver's model of the
  // rule is wrong even though the transaction succeeded, which is worth
  // shouting about.
  const after = await chain.readMarket(entry.market);
  const recorded = after.entry.attestedOutcome;
  log(`${tag}: recorded outcome ${outcomeName(recorded)} at ${after.entry.attestedAt}`);
  if (expected != null && recorded !== expected) {
    warn(
      `${tag}: chain recorded ${outcomeName(recorded)} but this resolver predicted ` +
        `${outcomeName(expected)} — the local rule model disagrees with the program`,
    );
  }

  journal?.recordSuccess(entry.market, {
    signature,
    outcome: recorded,
    value: observed.raw,
    at: now,
  });

  return {
    market: entry.market,
    status: "attested",
    signature,
    outcome: recorded,
    value: observed.raw,
  };
}

// ── One pass ───────────────────────────────────────────────────────────────

export async function runPass({ chain, registry, source, plan, journal, only }) {
  const now = await chain.now();
  log(`pass at ${new Date(now * 1000).toISOString()} (chain time ${now})`);

  const results = [];
  for (const entry of registry) {
    if (!entry.enabled) {
      log(`${entry.label} ${entry.market}: skip — disabled in the registry`);
      continue;
    }
    if (only && entry.market !== only) continue;
    try {
      results.push(await resolveMarket({ chain, entry, source, now, plan, journal }));
    } catch (err) {
      // A market that throws outside the handled paths must not end the pass.
      errorOut(`${entry.label} ${entry.market}: unexpected — ${err?.stack ?? err}`);
      results.push({ market: entry.market, status: "failed", reason: String(err?.message ?? err) });
    }
  }

  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  log(
    `pass complete: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing to do"}`,
  );
  return results;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const env = loadEnv({ envFile: args.envFile });
  const config = resolveConfig(env);
  const registry = loadRegistry(config.registryPath);

  log(`rpc:      ${config.rpcUrl}`);
  log(`registry: ${config.registryPath} (${registry.length} markets)`);

  // Pins this process's attestation encoding against the reference vector in
  // `zk/primus.rs` before anything touches the network. Drift here would make
  // every attestation fail on chain for a reason that looks like a key problem.
  const { addr } = selfTestEncoding();
  log(`encoder self-test OK (reference attestor 0x${addr.slice(0, 8)}...)`);

  if (args.review) {
    return runReview({ config, registry });
  }

  // `--plan` reads chain state with no key, so an operator can inspect what
  // the resolver would do before funding anything.
  // `--plan`, and `--void` without `--publish`, are read-only: an operator
  // inspects what the resolver would do before funding or authorising anything.
  const readOnly = (args.plan || (args.void && !args.publish)) && !config.keypairRaw;
  const payer = readOnly ? null : parseKeypair(config.keypairRaw);
  const chain = await Chain.connect({
    rpcUrl: config.rpcUrl,
    payer,
    programId: config.programId,
  });
  log(`program:  ${chain.programId.toBase58()}`);

  if (payer) {
    const balance = await chain.connection.getBalance(payer.publicKey);
    log(`fee payer: ${payer.publicKey.toBase58()} (${(balance / 1e9).toFixed(4)} SOL)`);
    if (balance === 0) {
      warn("fee payer has no SOL — every submission will fail");
    }
  } else {
    log("fee payer: none (--plan, read-only)");
  }

  if (args.void) {
    return runVoid({ chain, registry, args, log, warn, errorOut, bs58Decode, sdk });
  }

  const source = buildSource({ args, config });
  log(`source:   ${source.name} (attestor ${source.attestorEvm})`);

  const journal = new Journal(config.statePath);

  if (args.watch) {
    log(`watching, ${config.intervalMs}ms between passes`);
    // Terminates only on a signal. Each pass is independently correct, so a
    // crash mid-pass loses nothing that the next pass cannot recompute from
    // the chain.
    for (;;) {
      try {
        await runPass({ chain, registry, source, plan: args.plan, journal, only: args.only });
      } catch (err) {
        errorOut(`pass failed — ${err?.stack ?? err}`);
      }
      await sleep(config.intervalMs);
    }
  }

  const results = await runPass({
    chain,
    registry,
    source,
    plan: args.plan,
    journal,
    only: args.only,
  });
  // A refusal is a configuration error the operator must see; cron reports a
  // non-zero exit. A transient failure is not, and does not fail the pass.
  return results.some((r) => r.status === "refused") ? 1 : 0;
}

function buildSource({ args, config }) {
  if (args.source === "fixture") {
    const raw = process.env.FIXTURE_ATTESTOR_KEY;
    if (!raw) {
      throw new Error(
        "--source fixture needs FIXTURE_ATTESTOR_KEY (32 bytes of hex) — the key the " +
          "watched markets were registered to. scripts/dry-run-devnet.mjs sets this itself.",
      );
    }
    const privKey = Uint8Array.from(Buffer.from(raw.replace(/^0x/, ""), "hex"));
    if (privKey.length !== 32) {
      throw new Error(`FIXTURE_ATTESTOR_KEY must be 32 bytes of hex, got ${privKey.length}`);
    }
    return fixtureSource({ privKey });
  }
  if (args.source !== "primus") {
    throw new Error(`unknown --source ${args.source} (expected "primus" or "fixture")`);
  }
  // `--plan` never requests an attestation, so it must not demand credentials
  // — inspecting what the resolver would do is exactly what an operator wants
  // to be able to do BEFORE provisioning secrets. The stub still carries the
  // Primus attestor address, so the preflight that catches a market registered
  // to the wrong attestor still runs and still reports.
  if (args.plan && (!config.primusAppId || !config.primusAppSecret)) {
    return {
      name: "primus (unconfigured — plan only)",
      attestorEvm: PADO_ATTESTOR,
      preflight: primusPreflight,
      attest() {
        throw new Error("plan mode cannot attest; set PRIMUS_APP_ID and PRIMUS_APP_SECRET");
      },
    };
  }
  return primusSource({
    appId: config.primusAppId,
    appSecret: config.primusAppSecret,
    timeoutMs: config.primusTimeoutMs,
  });
}

/**
 * Gemini rule review. Advisory: it prints prose for a human and resolves
 * nothing. See the boundary note at the top of `gemini.mjs`.
 */
async function runReview({ config, registry }) {
  const { reviewRule } = await import("./gemini.mjs");
  log("Gemini rule review — ADVISORY ONLY. No outcome is decided here.");
  const chain = await Chain.connect({ rpcUrl: config.rpcUrl, payer: null, programId: config.programId });
  for (const entry of registry) {
    const state = await chain.readMarket(entry.market);
    const onChain = state.exists
      ? {
          question: state.market.question,
          comparatorName: COMPARATOR_NAMES[state.entry.comparator],
          thresholdDisplay: fromFixedPoint(state.entry.threshold, state.entry.valueScale),
        }
      : null;
    log(`--- ${entry.label} ${entry.market} ---`);
    try {
      process.stdout.write(`${await reviewRule({ apiKey: config.geminiApiKey, entry, onChain })}\n`);
    } catch (err) {
      errorOut(`review failed — ${err.message}`);
    }
  }
  return 0;
}

// Only run when invoked directly; the tests import `parseArgs`/`resolveMarket`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      errorOut(err?.stack ?? err);
      process.exit(1);
    });
}

export { PADO_ATTESTOR };
