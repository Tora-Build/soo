#!/usr/bin/env node
// T* voiding, end to end against devnet, WITHOUT publishing.
//
//     node scripts/void-dry-run-devnet.mjs
//
// `test/void-*.test.mjs` prove the accounting and the tree shape as pure
// functions, and `packages/sdk-solana/tests/t-star-voiding-resolver.test.ts`
// proves the program accepts what this resolver builds. What neither can prove
// is the REPLAY: that the event tape a live cluster emits decodes into the
// trades the entitlement function expects. That is what this does.
//
// It creates its own throwaway market, trades it on both sides of a T* it
// chooses, locks and attests it, and then runs the same `buildCommitment` the
// `--void` CLI runs — over events it did not write, read back off devnet.
// Nothing is published: `publish_resolution_commitment` is one-shot and
// unamendable, so this stops at the table.
//
// Credentials are READ from `apps/demo/.env.local`, the same file
// `scripts/dry-run-devnet.mjs` reads. Nothing is written back.
//
// No emojis in output (project rule).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Chain, bs58Decode, cuLimitIx, describeError, heapFrameIx, ixFromMeta, sdk, sleep } from "../src/chain.mjs";
import { parseEnvFile, parseKeypair } from "../src/config.mjs";
import { REPO_ROOT, loadAnchor, loadWeb3 } from "../src/deps.mjs";
import { buildCommitment, proofArtifact, renderTable } from "../src/void/commitment.mjs";
import { installBookDecoders } from "../src/void/tape.mjs";
import { hex, verifyProof } from "../src/void/merkle.mjs";

const web3 = await loadWeb3();
const { LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } = web3;
const anchor = await loadAnchor();
const { BN } = anchor;

const ENV_LOCAL = resolve(REPO_ROOT ?? ".", "apps", "demo", ".env.local");
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const VENUE_MINT = new PublicKey("ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX");

const WAD = 10n ** 18n;
// Liquidity parameter. Large enough that the vault covers the CONSERVATIVE
// solvency bound `publish_resolution_commitment` applies: a voided share is
// counted twice there, once at face in the outstanding ledger and again inside
// the refund ceiling, so a thin market cannot publish a tree it can afford.
const B_WAD = 60n * WAD;
/** Seconds the market stays open. Long enough for two trades to straddle T*. */
const TRADING_SECS = Number(process.env.VOID_TRADING_SECS ?? 70);
/** Gap between the honest buy and the informed one, with T* in the middle. */
const GAP_SECS = Number(process.env.VOID_GAP_SECS ?? 30);

const OUTCOME_YES = 1;

/** `--publish` also attests and submits the commitment, on the market this script created. */
const PUBLISH = process.argv.includes("--publish");

const log = (m) => process.stdout.write(`[void-dry-run] ${m}\n`);
const step = (m) => process.stdout.write(`\n[void-dry-run] === ${m} ===\n`);
const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(msg) {
  process.stderr.write(`[void-dry-run] ERROR: ${msg}\n`);
  process.exit(1);
}

const ixFromSerialized = (s) =>
  ixFromMeta({ ixProgramId: s.programId, ixKeys: s.keys, ixData: s.data });

/** Submit a request the SDK built, replaying its pre-instructions in order. */
async function submitRequest(chain, req, signer) {
  const tx = new Transaction().add(cuLimitIx(), heapFrameIx());
  for (const pre of req.meta.preIxs ?? []) tx.add(ixFromSerialized(pre));
  tx.add(ixFromMeta(req.meta));
  return chain.sendAndConfirm(tx, [signer]);
}

async function createMarket({ chain, authority, deadline }) {
  const P = { soothCore: chain.programId };
  const marketId = Uint8Array.from(randomBytes(16));
  const [marketPda] = sdk.pdas.deriveMarketPda(marketId, P);
  const startTime = Math.floor(Date.now() / 1000);
  const question = `zk-resolver T* dry run ${Buffer.from(marketId).toString("hex").slice(0, 8)}: did the thing happen?`;
  const questionHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(question)),
  );

  const tx = await chain.program.methods
    .createMarket({
      marketId: Array.from(marketId),
      question,
      questionHash: Array.from(questionHash),
      startTime: new BN(startTime),
      deadline: new BN(deadline),
      adjudicator: authority.publicKey,
      initialB: new BN(B_WAD.toString()),
    })
    .accounts({
      config: sdk.pdas.deriveProtocolConfigPda(P)[0],
      market: marketPda,
      vaultAuthority: sdk.pdas.deriveVaultAuthorityPda(marketId, P)[0],
      lockAuthority: sdk.pdas.deriveLockAuthorityPda(marketId, P)[0],
      bookMint: VENUE_MINT,
      ammMint: VENUE_MINT,
      vaultBook: sdk.pdas.deriveMarketVaultAta(marketId, VENUE_MINT, P),
      vaultAmm: sdk.pdas.deriveMarketVaultAmm(marketId, P),
      lockVault: sdk.pdas.deriveLockVaultAta(marketId, VENUE_MINT, P),
      ammState: sdk.pdas.deriveAmmStatePda(marketId, P)[0],
      creator: authority.publicKey,
      tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([cuLimitIx(), heapFrameIx()])
    .transaction();
  log(`createMarket ${await chain.sendAndConfirm(tx, [authority])}`);

  // A MANUAL adjudicator: this dry run is about the tree, not about zkTLS, and
  // T* for a manual market is the operator's stated judgement anyway.
  // `create_market` composes the adjudicator entry itself, so this only runs
  // on a deployment where it does not.
  const entryPk = chain.adjudicatorPda(marketPda);
  if (!(await chain.connection.getAccountInfo(entryPk, "confirmed"))) {
    const reg = await chain.adapter.buildRegisterAdjudicator(`sol:${marketPda.toBase58()}`, {
      user: `sol:${authority.publicKey.toBase58()}`,
      authority: `sol:${authority.publicKey.toBase58()}`,
    });
    log(`registerAdjudicator ${await submitRequest(chain, reg, authority)}`);
  }

  return { marketId, marketPda, startTime, deadline };
}

async function main() {
  step("preflight");
  log(`rpc: ${RPC_URL}`);
  if (!existsSync(ENV_LOCAL)) fail(`${ENV_LOCAL} not found — this dry run reads devnet keys from there`);
  const env = parseEnvFile(readFileSync(ENV_LOCAL, "utf8"));
  const authority = parseKeypair(env.VITE_TEST_AUTHORITY_BYTES, "VITE_TEST_AUTHORITY_BYTES");
  const trader = env.VITE_TEST_KEYPAIR_BYTES
    ? parseKeypair(env.VITE_TEST_KEYPAIR_BYTES, "VITE_TEST_KEYPAIR_BYTES")
    : authority;
  log(`market authority: ${authority.publicKey.toBase58()}`);
  log(`trader:           ${trader.publicKey.toBase58()}`);

  const chain = await Chain.connect({ rpcUrl: RPC_URL, payer: authority });
  const asTrader = await Chain.connect({ rpcUrl: RPC_URL, payer: trader });
  installBookDecoders({
    decodeBookEventsFromInner: sdk.decodeBookEventsFromInner,
    bs58Decode,
  });
  log(`program: ${chain.programId.toBase58()}`);
  for (const [name, kp] of [["authority", authority], ["trader", trader]]) {
    const bal = await chain.connection.getBalance(kp.publicKey);
    log(`${name} balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    if (bal < 0.05 * LAMPORTS_PER_SOL) fail(`${name} is out of SOL`);
  }

  // ── A market, seeded and traded on both sides of T* ───────────────────────
  step("creating a fresh market");
  const deadline = Math.floor(Date.now() / 1000) + TRADING_SECS;
  const market = await createMarket({ chain, authority, deadline });
  const marketRef = `sol:${market.marketPda.toBase58()}`;
  log(`market: ${market.marketPda.toBase58()}`);

  const seed = await chain.adapter.buildSeedLp(marketRef, {
    creator: `sol:${authority.publicKey.toBase58()}`,
  });
  log(`seedLp ${await submitRequest(chain, seed, authority)}`);

  step("the honest trade, before T*");
  const buy1 = await asTrader.adapter.buildTrade(marketRef, {
    user: `sol:${trader.publicKey.toBase58()}`,
    outcome: OUTCOME_YES,
    deltaShares: 4n * WAD,
    maxCostWad: 100n * WAD,
    side: "buy",
  });
  log(`trade #1 (4 YES) ${await submitRequest(asTrader, buy1, trader)}`);

  log(`waiting ${GAP_SECS}s so the second trade lands on the other side of T*`);
  await sleep((GAP_SECS / 2) * 1000);
  // T* between the two trades: the event became public here, and everything
  // after it is a withdrawal from the pool rather than a prediction.
  const tStar = Math.floor(Date.now() / 1000);
  log(`T* = ${tStar} (${new Date(tStar * 1000).toISOString()})`);
  await sleep((GAP_SECS / 2) * 1000);

  step("the informed trade, after T*");
  const buy2 = await asTrader.adapter.buildTrade(marketRef, {
    user: `sol:${trader.publicKey.toBase58()}`,
    outcome: OUTCOME_YES,
    deltaShares: 6n * WAD,
    maxCostWad: 100n * WAD,
    side: "buy",
  });
  log(`trade #2 (6 YES) ${await submitRequest(asTrader, buy2, trader)}`);

  // ── The tree, from the tape the cluster emitted ───────────────────────────
  //
  // Computed BEFORE the lock, deliberately. `publish_resolution_commitment`
  // is only accepted while the veto window is open, and this deployment's
  // `veto_period_secs` is measured in SECONDS — so a resolver that starts
  // replaying the tape after the attestation has already missed the window.
  // Nothing is lost by computing early: trading stops at the lock, so the
  // tape is final from that moment and T* is known before it.
  step("locking, then replaying the tape and building the tree");
  const waitMs = (deadline + 3) * 1000 - Date.now();
  if (waitMs > 0) {
    log(`waiting ${Math.ceil(waitMs / 1000)}s for the deadline`);
    await sleep(waitMs);
  }
  const lock = await chain.adapter.buildRequestLock(marketRef, {
    user: `sol:${authority.publicKey.toBase58()}`,
  });
  log(`requestLock ${await submitRequest(chain, lock, authority)}`);

  const plan = await buildCommitment({
    chain,
    marketPk: market.marketPda,
    tStar,
    tStarSource: "operator",
  });
  process.stdout.write(`\n${renderTable(plan)}\n`);

  const row = plan.ammRows.find((r) => r.wallet === trader.publicKey.toBase58());
  record("the trader has a leaf", Boolean(row), row?.wallet);
  record(
    "the pre-T* buy settles and the post-T* buy does not",
    row?.validYesWad === 4n * WAD && row?.voidedYesWad === 6n * WAD,
    `valid ${row?.validYesWad} voided ${row?.voidedYesWad}`,
  );
  record(
    "the refund is the post-T* lot's cost, inside the position's locked cost",
    row?.voidRefundUsdc > 0n && row?.voidRefundUsdc <= row?.lockedCostUsdc,
    `refund ${row?.voidRefundUsdc} of ${row?.lockedCostUsdc}`,
  );
  record(
    "the published ceiling equals the sum of the tree's refunds",
    plan.totalVoidRefundUsdc === plan.ammRows.reduce((s, r) => s + r.voidRefundUsdc, 0n),
    `${plan.totalVoidRefundUsdc}`,
  );
  record(
    "every leaf verifies against the root this run would publish",
    plan.rows.every((r) => verifyProof(r.leaf, r.proof, plan.root)),
    hex(plan.root),
  );

  const outDir = resolve(REPO_ROOT ?? ".", "infra", "zk-resolver", ".state", "resolutions");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `${market.marketPda.toBase58()}.json`);
  writeFileSync(outPath, `${JSON.stringify(proofArtifact(plan), null, 2)}\n`);
  log(`proofs written to ${outPath}`);

  if (!PUBLISH) {
    step("NOT published");
    log(
      `publish_resolution_commitment is one-shot and unamendable, so this dry run stops here. ` +
        `Re-run with --publish to attest and publish on a market this script created.`,
    );
    log(`  node scripts/void-dry-run-devnet.mjs --publish`);
  } else {
    // Attest and publish back to back. The window opens at the attestation and
    // this deployment closes it seconds later, so the tree has to be ready
    // first — which it is, computed above.
    //
    // ONE TRANSACTION. The veto window opens at the attestation, and this
    // deployment sets `veto_period_secs = 2` — shorter than a devnet
    // confirmation round trip, so two transactions can never both land inside
    // it. Batching is not a trick: `publish_resolution_commitment` reads
    // `attested_at` from an account the instruction before it just wrote, and
    // the window it checks is genuinely open at that instant.
    step("attesting and publishing inside the veto window, in one transaction");
    const attest = await chain.adapter.buildAttestOutcome(marketRef, {
      user: `sol:${authority.publicKey.toBase58()}`,
      winningOutcome: OUTCOME_YES,
    });
    try {
      const sig = await chain.publishResolutionCommitment(
        market.marketPda,
        {
          resolutionCommitment: plan.refs.resolutionCommitment,
          adjudicatorEntry: chain.adjudicatorPda(market.marketPda),
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
        { extraPreIxs: [ixFromMeta(attest.meta)] },
      );
      log(`attest_outcome + publish_resolution_commitment ${sig}`);
      const stored = await chain.readResolutionCommitment(plan.refs.resolutionCommitment);
      record(
        "the chain holds the root this run built",
        Boolean(stored) && Buffer.from(stored.merkleRoot).equals(plan.root),
        stored ? hex(Buffer.from(stored.merkleRoot)) : "not found",
      );
    } catch (err) {
      record("publish_resolution_commitment accepted", false, describeError(err));
    }
  }

  step("summary");
  const failed = results.filter((r) => !r.passed);
  for (const r of results) log(`${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
  log(`${results.length - failed.length}/${results.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[void-dry-run] ERROR ${describeError(err)}\n${err?.stack ?? ""}\n`);
    process.exit(1);
  });
