#!/usr/bin/env node
// Exercises the ENTIRE resolver loop against devnet, without Primus.
//
//     node scripts/dry-run-devnet.mjs
//
// The service's one un-runnable dependency without credentials is the Primus
// attestation itself. Everything else — deadline detection, rule-hash
// verification against the chain, locking, submission, read-back, idempotency
// — is real, and this proves it by swapping only the attestation source for
// the locally-signed `fixture` one.
//
// What it does:
//
//   1. Generates a throwaway secp256k1 attestor key and creates a fresh market
//      registered to it, committed to a real public price endpoint.
//   2. Writes a temporary registry naming that market.
//   3. Waits for the deadline, then runs `runPass` — the same function `--once`
//      runs. It locks the market and submits `attest_outcome_zk`.
//   4. Runs `runPass` a SECOND time and asserts it skips: the market is
//      already attested on chain, so nothing is re-submitted. This is the
//      idempotency proof, and it holds with a fresh journal.
//   5. Runs a THIRD pass against a deliberately corrupted registry entry and
//      asserts the resolver REFUSES on the rule-hash mismatch rather than
//      submitting.
//
// Credentials are READ from `apps/demo/.env.local` (the same file
// `apps/demo/scripts/zk-attest-devnet.mjs` reads). Nothing is written back.
//
// No emojis in output (project rule).

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Chain, cuLimitIx, heapFrameIx, ixFromMeta, sdk, sleep } from "../src/chain.mjs";
import { parseEnvFile, parseKeypair } from "../src/config.mjs";
import { REPO_ROOT } from "../src/deps.mjs";
import { evmAddress, hex, selfTestEncoding } from "../src/evm.mjs";
import { fetchFeedValue, fromFixedPoint, toFixedPoint } from "../src/feed.mjs";
import { loadRegistry } from "../src/registry.mjs";
import { fixtureSource } from "../src/sources/fixture.mjs";
import { Journal } from "../src/state.mjs";
import { runPass } from "../src/index.mjs";
import { loadAnchor, loadWeb3 } from "../src/deps.mjs";

const web3 = await loadWeb3();
const {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} = web3;
const anchor = await loadAnchor();
const { BN } = anchor;

// ── Configuration ──────────────────────────────────────────────────────────

const ENV_LOCAL = resolve(REPO_ROOT ?? ".", "apps", "demo", ".env.local");
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

// Both venue roles are filled by the same mock-USDC mint on this deployment.
const VENUE_MINT = new PublicKey("ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX");

// A real endpoint with no auth, a stable shape, and a value that moves — so
// the attested number is visibly a live reading.
const FEED = {
  url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
  parsePath: "$.data.amount",
  keyName: "amount",
  parseType: "string",
  method: "GET",
  header: '{"accept":"application/json"}',
  body: "",
};
const VALUE_SCALE = 6;
const THRESHOLD_MARGIN_USD = 1_000n;
const DEADLINE_SECS = Number(process.env.ZK_DEADLINE_SECS ?? 25);
const B_WAD = 10n ** 18n;

const results = [];
const log = (m) => process.stdout.write(`[dry-run] ${m}\n`);
const step = (m) => process.stdout.write(`\n[dry-run] === ${m} ===\n`);
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(msg) {
  process.stderr.write(`[dry-run] ERROR: ${msg}\n`);
  process.exit(1);
}

// ── Market creation ────────────────────────────────────────────────────────

/**
 * A fresh market registered to `attestorEvm`, committed to the feed above.
 *
 * Random market id, so this never collides with the demo's markets and is
 * never written into `.env.local`.
 */
async function createMarket({ chain, authority, attestorEvm, ruleHash, threshold }) {
  const P = { soothCore: chain.programId };
  const marketId = Uint8Array.from(randomBytes(16));
  const [marketPda] = sdk.pdas.deriveMarketPda(marketId, P);
  const [configPda] = sdk.pdas.deriveProtocolConfigPda(P);
  const [ammStatePda] = sdk.pdas.deriveAmmStatePda(marketId, P);

  const startTime = Math.floor(Date.now() / 1000);
  const deadline = startTime + DEADLINE_SECS;
  const question =
    `zk-resolver dry run: will BTC-USD spot exceed ` +
    `${fromFixedPoint(threshold, VALUE_SCALE)} USD at deadline?`;

  const createTx = await chain.program.methods
    .createMarket({
      marketId: Array.from(marketId),
      question,
      questionHash: Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(question)),
        ),
      ),
      startTime: new BN(startTime),
      deadline: new BN(deadline),
      adjudicator: authority.publicKey,
      initialB: new BN(B_WAD.toString()),
    })
    .accounts({
      config: configPda,
      market: marketPda,
      vaultAuthority: sdk.pdas.deriveVaultAuthorityPda(marketId, P)[0],
      lockAuthority: sdk.pdas.deriveLockAuthorityPda(marketId, P)[0],
      bookMint: VENUE_MINT,
      ammMint: VENUE_MINT,
      vaultBook: sdk.pdas.deriveMarketVaultAta(marketId, VENUE_MINT, P),
      vaultAmm: sdk.pdas.deriveMarketVaultAmm(marketId, P),
      lockVault: sdk.pdas.deriveLockVaultAta(marketId, VENUE_MINT, P),
      ammState: ammStatePda,
      creator: authority.publicKey,
      tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([cuLimitIx(), heapFrameIx()])
    .transaction();
  const createSig = await chain.sendAndConfirm(createTx, [authority]);
  log(`createMarket ${createSig}`);

  const req = await chain.adapter.buildRegisterZkAdjudicator(`sol:${marketPda.toBase58()}`, {
    user: `sol:${authority.publicKey.toBase58()}`,
    authority: `sol:${authority.publicKey.toBase58()}`,
    attestorEvm,
    ruleHash,
    comparator: sdk.ZK_COMPARATOR.Gt,
    threshold,
    valueScale: VALUE_SCALE,
  });
  const registerSig = await chain.sendAndConfirm(
    new Transaction().add(heapFrameIx(), ixFromMeta(req.meta)),
    [authority],
  );
  log(`registerZkAdjudicator ${registerSig}`);

  return { marketId, marketPda, deadline, question };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  step("preflight");
  log(`rpc: ${RPC_URL}`);
  const { addr } = selfTestEncoding();
  record("encoder matches the Primus reference vector", true, `reference attestor 0x${addr.slice(0, 8)}...`);

  if (!existsSync(ENV_LOCAL)) fail(`${ENV_LOCAL} not found — this dry run reads devnet keys from there`);
  const env = parseEnvFile(readFileSync(ENV_LOCAL, "utf8"));
  const authority = parseKeypair(env.VITE_TEST_AUTHORITY_BYTES, "VITE_TEST_AUTHORITY_BYTES");
  // The resolver's fee payer is a DIFFERENT key from the market's authority
  // wherever possible, to demonstrate that attestation is permissionless. It
  // falls back to the authority only if the second key is absent.
  const feePayer = env.VITE_TEST_KEYPAIR_BYTES
    ? parseKeypair(env.VITE_TEST_KEYPAIR_BYTES, "VITE_TEST_KEYPAIR_BYTES")
    : authority;
  log(`market authority: ${authority.publicKey.toBase58()}`);
  log(`resolver payer:   ${feePayer.publicKey.toBase58()}`);

  const chainAsAuthority = await Chain.connect({ rpcUrl: RPC_URL, payer: authority });
  log(`program: ${chainAsAuthority.programId.toBase58()}`);

  for (const [name, kp] of [["authority", authority], ["fee payer", feePayer]]) {
    const bal = await chainAsAuthority.connection.getBalance(kp.publicKey);
    log(`${name} balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    if (bal < 0.05 * LAMPORTS_PER_SOL) fail(`${name} is out of SOL`);
  }

  // ── The attestor stand-in ────────────────────────────────────────────────
  step("fixture attestor and rule");
  const privKey = Uint8Array.from(randomBytes(32));
  const attestorEvm = `0x${hex(evmAddress(privKey))}`;
  log(`fixture attestor: ${attestorEvm}`);

  const preview = await fetchFeedValue(FEED);
  log(`${FEED.url} -> ${FEED.parsePath} = ${preview.raw}`);
  const threshold =
    toFixedPoint(preview.raw, VALUE_SCALE) - THRESHOLD_MARGIN_USD * 10n ** BigInt(VALUE_SCALE);
  if (threshold <= 0n) fail(`feed value ${preview.raw} is below the chosen margin`);
  const ruleHash = await sdk.computeRuleHash(FEED.url, FEED.parsePath);
  log(`rule: value GT ${fromFixedPoint(threshold, VALUE_SCALE)} at scale ${VALUE_SCALE}`);
  log(`rule_hash: 0x${hex(ruleHash)}`);

  // ── Market ───────────────────────────────────────────────────────────────
  step("creating a fresh zk market");
  const market = await createMarket({
    chain: chainAsAuthority,
    authority,
    attestorEvm,
    ruleHash,
    threshold,
  });
  log(`market: ${market.marketPda.toBase58()}`);

  // ── Registry ─────────────────────────────────────────────────────────────
  const workDir = mkdtempSync(join(tmpdir(), "zk-resolver-dryrun-"));
  const registryPath = join(workDir, "markets.json");
  const statePath = join(workDir, "resolver.json");
  const entry = { market: market.marketPda.toBase58(), label: "dry-run", ...FEED };
  writeFileSync(registryPath, JSON.stringify({ markets: [entry] }, null, 2));
  log(`registry: ${registryPath}`);

  const registry = loadRegistry(registryPath);
  const source = fixtureSource({ privKey });

  // The resolver's own chain handle, holding ONLY the fee payer. The market's
  // authority is a different key, so `request_lock` is not available to it —
  // which is the honest production shape and is asserted below.
  const resolverChain = await Chain.connect({ rpcUrl: RPC_URL, payer: feePayer });

  try {
    // ── Pass 0: before the deadline ────────────────────────────────────────
    step("PASS 0: before the deadline, nothing is due");
    const pass0 = await runPass({
      chain: resolverChain,
      registry,
      source,
      journal: new Journal(statePath),
    });
    record(
      "a market before its deadline is skipped",
      pass0[0]?.status === "skipped" && /deadline not passed/.test(pass0[0].reason ?? ""),
      pass0[0]?.reason,
    );

    // ── Lock ───────────────────────────────────────────────────────────────
    step("waiting for the deadline, then locking");
    const waitMs = (market.deadline + 2) * 1000 - Date.now();
    if (waitMs > 0) {
      log(`waiting ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
    // `request_lock` is signer-gated on the entry's authority. The resolver's
    // fee payer is not that authority, so this is done with the authority
    // key — exactly as an operator would have to.
    const state = await chainAsAuthority.readMarket(entry.market);
    const lockSig = await chainAsAuthority.requestLock(state.marketPk, state.entryPk);
    log(`request_lock ${lockSig}`);

    // ── Pass 1: the real thing ─────────────────────────────────────────────
    step("PASS 1: due, locked, un-attested -> attest");
    const journal = new Journal(statePath);
    const pass1 = await runPass({ chain: resolverChain, registry, source, journal });
    const r1 = pass1[0];
    record(
      "the resolver submits attest_outcome_zk for a due market",
      r1?.status === "attested" && !!r1.signature,
      r1?.signature ?? r1?.reason,
    );

    // Read back: the chain's own record, not this process's prediction.
    const after = await resolverChain.readMarket(entry.market);
    record(
      "the market is attested on chain afterwards",
      after.entry.attestedOutcome !== null && after.entry.attestedAt !== null,
      `outcome=${after.entry.attestedOutcome} at=${after.entry.attestedAt}`,
    );

    // ── Pass 2: idempotency ────────────────────────────────────────────────
    step("PASS 2: same registry, same market -> must skip");
    const pass2 = await runPass({ chain: resolverChain, registry, source, journal });
    record(
      "a second pass skips the already-attested market",
      pass2[0]?.status === "skipped" && /already attested/.test(pass2[0].reason ?? ""),
      pass2[0]?.reason,
    );

    // ── Pass 3: restart survival ───────────────────────────────────────────
    // A FRESH journal, as if the process had restarted with no memory. The
    // chain alone must be enough to prevent a double submission.
    step("PASS 3: fresh journal (simulated restart) -> must still skip");
    rmSync(statePath, { force: true });
    const pass3 = await runPass({
      chain: resolverChain,
      registry,
      source,
      journal: new Journal(statePath),
    });
    record(
      "idempotency survives a restart with no local state",
      pass3[0]?.status === "skipped" && /already attested/.test(pass3[0].reason ?? ""),
      pass3[0]?.reason,
    );

    // ── Pass 4: rule-hash mismatch is refused ──────────────────────────────
    step("PASS 4: a registry entry describing a different endpoint -> must refuse");
    const badRegistryPath = join(workDir, "markets-bad.json");
    writeFileSync(
      badRegistryPath,
      JSON.stringify(
        { markets: [{ ...entry, url: "https://api.coinbase.com/v2/prices/ETH-USD/spot" }] },
        null,
        2,
      ),
    );
    const badRegistry = loadRegistry(badRegistryPath);

    // A second market, un-attested, so the refusal is reached rather than
    // short-circuited by the already-attested skip.
    const market2 = await createMarket({
      chain: chainAsAuthority,
      authority,
      attestorEvm,
      ruleHash,
      threshold,
    });
    badRegistry[0].market = market2.marketPda.toBase58();
    const wait2 = (market2.deadline + 2) * 1000 - Date.now();
    if (wait2 > 0) {
      log(`waiting ${Math.ceil(wait2 / 1000)}s for market-2's deadline`);
      await sleep(wait2);
    }
    const s2 = await chainAsAuthority.readMarket(badRegistry[0].market);
    log(`request_lock ${await chainAsAuthority.requestLock(s2.marketPk, s2.entryPk)}`);

    const pass4 = await runPass({
      chain: resolverChain,
      registry: badRegistry,
      source,
      journal: new Journal(join(workDir, "resolver2.json")),
    });
    record(
      "a rule-hash mismatch is refused, and nothing is submitted",
      pass4[0]?.status === "refused",
      pass4[0]?.reason?.slice(0, 120),
    );
    const after2 = await resolverChain.readMarket(badRegistry[0].market);
    record(
      "the refused market is left unattested",
      after2.entry.attestedOutcome === null,
      `attested_outcome=${after2.entry.attestedOutcome}`,
    );

    // ── Summary ────────────────────────────────────────────────────────────
    step("SUMMARY");
    log(`attested market: ${market.marketPda.toBase58()}`);
    log(`refused market:  ${market2.marketPda.toBase58()}`);
    if (r1?.signature) log(`attest_outcome_zk: ${r1.signature}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  process.stdout.write("\n");
  for (const r of results) {
    process.stdout.write(
      `  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `\n          ${r.detail}` : ""}\n`,
    );
  }
  const failed = results.filter((r) => !r.passed).length;
  process.stdout.write(
    `\n[dry-run] ${failed === 0 ? "ALL PASS" : `${failed} FAILED`} (${results.length} checks)\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[dry-run] UNCAUGHT: ${err?.stack ?? err}\n`);
  if (err?.logs) process.stderr.write(`${err.logs.join("\n")}\n`);
  process.exit(1);
});
