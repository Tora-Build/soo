// `--void`: the T\* entitlement pass.
//
// One market at a time, and PRINT-BY-DEFAULT. Publication is a one-shot,
// unamendable act inside a closing veto window (`publish_resolution.rs` uses
// `init`, not `init_if_needed`), so the flow is deliberately two-step: look at
// the table, then pass `--publish`.
//
// What this does NOT do is decide T\*. For a zkTLS market `--t-star auto`
// reads the attestation's own signed timestamp out of the `ZkOutcomeAttested`
// log; for a manual market the operator states it. Either way the program
// bounds it (`start_time < t_star <= min(attested_at, deadline)`) and the veto
// window is what makes a wrong one disputable.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { SERVICE_ROOT, loadWeb3 } from "../deps.mjs";
import { describeError } from "../chain.mjs";
import { buildCommitment, proofArtifact, renderTable } from "./commitment.mjs";
import { installBookDecoders, readZkAttestationTs } from "./tape.mjs";
import { hex } from "./merkle.mjs";

const { PublicKey } = await loadWeb3();

/** Where the per-market proof file lands when `--out` is not given. */
export const DEFAULT_OUT_DIR = resolve(SERVICE_ROOT, ".state", "resolutions");

export async function runVoid({ chain, registry, args, log, warn, errorOut, bs58Decode, sdk }) {
  // The book's fills ride `emit_cpi!` inner instructions, which web3.js hands
  // back base58-encoded. Both decoders come from the SDK so the resolver reads
  // the book exactly as the demo does.
  installBookDecoders({
    decodeBookEventsFromInner: sdk.decodeBookEventsFromInner,
    bs58Decode,
  });

  const targets = selectTargets({ registry, only: args.only });
  if (targets.length === 0) {
    errorOut(
      "--void needs a market: pass --only <pubkey>, or add the market to markets.json",
    );
    return 1;
  }
  if (args.publish && !chain.payer) {
    errorOut("--publish needs RESOLVER_KEYPAIR, and it must be the market's adjudicator authority");
    return 1;
  }

  let failures = 0;
  for (const target of targets) {
    try {
      const code = await voidOneMarket({ chain, target, args, log, warn, errorOut });
      if (code !== 0) failures += 1;
    } catch (err) {
      errorOut(`${target.label} ${target.market}: ${err?.stack ?? err}`);
      failures += 1;
    }
  }
  return failures === 0 ? 0 : 1;
}

function selectTargets({ registry, only }) {
  if (only) {
    const known = registry.find((e) => e.market === only);
    return [known ?? { market: only, label: only.slice(0, 8) }];
  }
  return registry.filter((e) => e.enabled !== false);
}

async function voidOneMarket({ chain, target, args, log, warn, errorOut }) {
  const marketPk = new PublicKey(target.market);
  const tag = `${target.label} ${target.market}`;

  // ── T* ───────────────────────────────────────────────────────────────────
  const resolved = await resolveTStar({ chain, marketPk, arg: args.tStar, log });
  if (!resolved) {
    errorOut(
      `${tag}: no T* — pass --t-star <unix seconds> for a manually adjudicated market, ` +
        `or --t-star auto for a zkTLS one (which needs a ZkOutcomeAttested log to read)`,
    );
    return 1;
  }
  log(`${tag}: T* ${resolved.tStar} (${new Date(resolved.tStar * 1000).toISOString()}) via ${resolved.source}`);

  // ── The tree ─────────────────────────────────────────────────────────────
  log(`${tag}: replaying the event tape...`);
  const plan = await buildCommitment({
    chain,
    marketPk,
    tStar: resolved.tStar,
    tStarSource: resolved.source,
    maxSignatures: args.maxSignatures,
    onProgress: (done, total) => log(`${tag}: ${done}/${total} transactions scanned`),
  });

  process.stdout.write(`\n${renderTable(plan)}\n`);

  // ── The artifact ─────────────────────────────────────────────────────────
  //
  // The file IS the proof distribution — a wallet cannot redeem a voided
  // position without it. So a run whose tree does NOT match the root already
  // on chain must never overwrite it: that would replace every live proof with
  // proofs against a root nobody published. It is written beside it instead,
  // loudly, because a mismatch is either a wrong T\* on this run or a wrong
  // commitment on chain, and both need a human.
  const published = await chain.readResolutionCommitment(plan.refs.resolutionCommitment);
  const publishedRoot = published ? Buffer.from(published.merkleRoot) : null;
  const diverged = publishedRoot != null && !publishedRoot.equals(plan.root);

  const outDir = args.out ? resolve(args.out) : DEFAULT_OUT_DIR;
  const outPath = resolve(
    outDir,
    diverged ? `${target.market}.mismatch.json` : `${target.market}.json`,
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(proofArtifact(plan), null, 2)}\n`);
  log(`${tag}: proofs written to ${outPath}`);
  if (diverged) {
    warn(
      `${tag}: this tree (${hex(plan.root)}) does NOT match the published root ` +
        `(${hex(publishedRoot)}). The live proof file was left untouched. Either T* is wrong ` +
        `here, or the published commitment is wrong — and while the veto window is open the ` +
        `dispute authority can revoke it.`,
    );
  }

  // ── Publish, or stop here ────────────────────────────────────────────────
  if (!args.publish) {
    log(
      `${tag}: PLAN — nothing submitted. Root ${hex(plan.root)}, ${plan.leafCount} leaves. ` +
        `Re-run with --publish to submit publish_resolution_commitment.`,
    );
    return plan.anomalies.length > 0 || diverged ? 1 : 0;
  }

  // The window, before the transaction rather than after it. A commitment is
  // only accepted while `now < attested_at + veto_period_secs`, and on a
  // deployment whose veto period is a handful of seconds the window can close
  // during the tape replay — so this reports the real reason rather than
  // letting it arrive as VetoWindowClosed.
  const window = await chain.readVetoWindow(marketPk, plan.refs.protocolConfig);
  if (!window.attested) {
    errorOut(`${tag}: not attested — a commitment can only accompany an attested outcome`);
    return 1;
  }
  if (window.secondsLeft <= 0) {
    errorOut(
      `${tag}: the veto window closed ${-window.secondsLeft}s ago ` +
        `(attested at ${window.attestedAt}, veto_period_secs ${window.vetoPeriodSecs}) — ` +
        `publication is refused after it. On a deployment with a veto period shorter than a ` +
        `confirmation round trip, attest and publish must ride ONE transaction; see ` +
        `scripts/void-dry-run-devnet.mjs.`,
    );
    return 1;
  }
  log(`${tag}: veto window closes in ${window.secondsLeft}s`);

  if (published) {
    errorOut(
      `${tag}: a commitment is already published at ${plan.refs.resolutionCommitment.toBase58()} ` +
        `(root ${hex(publishedRoot)}) — publication is one-shot; the dispute authority must ` +
        `revoke before another can land`,
    );
    return 1;
  }

  try {
    const sig = await chain.publishResolutionCommitment(
      marketPk,
      {
        resolutionCommitment: plan.refs.resolutionCommitment,
        adjudicatorEntry: chain.adjudicatorPda(marketPk),
        protocolConfig: plan.refs.protocolConfig,
        ammState: plan.refs.ammState,
        vaultAmm: plan.refs.vaultAmm,
        book: plan.refs.book,
        vaultBook: plan.refs.vaultBook,
      },
      {
        merkleRoot: plan.root,
        tStar: plan.tStar,
        leafCount: plan.leafCount,
        totalVoidRefundUsdc: plan.totalVoidRefundUsdc,
        totalBookVoidRefundUsdc: plan.totalBookVoidRefundUsdc,
      },
    );
    log(`${tag}: publish_resolution_commitment ${sig}`);
  } catch (err) {
    errorOut(`${tag}: publish_resolution_commitment rejected — ${describeError(err)}`);
    return 1;
  }

  // Read back, so the log records what the CHAIN holds rather than what this
  // process sent — the same discipline the attestation path follows.
  const stored = await chain.readResolutionCommitment(plan.refs.resolutionCommitment);
  if (!stored) {
    warn(`${tag}: published but the commitment did not read back`);
    return 1;
  }
  const storedRoot = Buffer.from(stored.merkleRoot);
  if (!storedRoot.equals(plan.root)) {
    warn(`${tag}: chain holds root 0x${storedRoot.toString("hex")}, this process built ${hex(plan.root)}`);
    return 1;
  }
  log(`${tag}: chain holds root ${hex(storedRoot)}, ${stored.leafCount} leaves, T* ${stored.tStar}`);
  return 0;
}

/**
 * T\*, from the operator or from the attestation.
 *
 * An explicit value always wins — a manual market has no attestation timestamp
 * to read, and an operator overriding a zkTLS one is stating a judgement the
 * veto window can challenge.
 */
async function resolveTStar({ chain, marketPk, arg, log }) {
  if (arg && arg !== "auto") {
    const n = Number(arg);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--t-star ${arg} is not unix seconds`);
    }
    return { tStar: n, source: "operator" };
  }
  const found = await readZkAttestationTs({
    connection: chain.connection,
    program: chain.program,
    marketPk,
  });
  if (!found) return null;
  log(`ZkOutcomeAttested in ${found.signature}: attestation_ts ${found.tStar}`);
  return { tStar: found.tStar, source: "zk-attestation" };
}
