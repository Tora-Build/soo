#!/usr/bin/env node
// Seed script for the devnet demo.
//
// Bootstraps the singleton on-chain state that `create_market` (and every
// AMM trade ix) reads:
//
//   1. `initialize_protocol` (sooth_launchpad)         — protocol-wide config PDA
//   2. `initialize_fee_pool`  (sooth_launchpad)        — global fee_pool USDC ATA
//   3. `initialize_adjudicator_allowlist` (sooth_market) — singleton allowlist PDA
//   4. `add_adjudicator`      (sooth_market)           — register the demo adjudicator
//
// Optionally seeds a market via `create_market` if the operator opts in via
// `--with-market`, the named adjudicator is allowlisted, and the wallet has
// USDC to fund the (small) initial vault. By default we skip the market
// step on devnet because the canonical USDC mint
// (`ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX`) is not freely mintable
// from a faucet — operators wanting an end-to-end seeded market should
// fund the wallet with devnet USDC out-of-band first.
//
// Usage:
//   node apps/demo/scripts/seed-devnet.mjs \
//     --keypair apps/demo/.deploy-payer.json \
//     [--rpc https://api.devnet.solana.com] \
//     [--with-market]
//
// All four bootstrap steps are idempotent — re-running the script is safe.
//
// No emojis (project rule).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import anchor from "@coral-xyz/anchor";
const { AnchorProvider, BN, Program } = anchor;

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEMO_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(DEMO_ROOT, "..", "..");

const SDK_DIST = resolve(REPO_ROOT, "packages", "sdk-solana", "dist");
const sdkUrl = (rel) => new URL(`file://${SDK_DIST}/${rel}`).href;

const { soothAdjudicatorIdl, soothAmmIdl, soothLaunchpadIdl, soothMarketIdl } =
  await import(sdkUrl("anchor/index.js"));
const {
  deriveAdjudicatorAllowlistPda,
  deriveAmmStatePda,
  deriveFeePoolAuthorityPda,
  deriveFeePoolVaultAta,
  deriveLockAuthorityPda,
  deriveLockVaultAta,
  deriveMarketPda,
  deriveMarketVaultAta,
  deriveNoMintPda,
  deriveProtocolConfigPda,
  deriveVaultAuthorityPda,
  deriveYesMintPda,
} = await import(sdkUrl("pdas.js"));
const { WAD } = await import(sdkUrl("math/lmsr.js"));

const SOOTH_AMM_ID = new PublicKey(soothAmmIdl.address);
const SOOTH_MARKET_ID = new PublicKey(soothMarketIdl.address);
const SOOTH_LAUNCHPAD_ID = new PublicKey(soothLaunchpadIdl.address);
const SOOTH_ADJUDICATOR_ID = new PublicKey(soothAdjudicatorIdl.address);
const PROGRAMS = {
  soothAmm: SOOTH_AMM_ID,
  soothMarket: SOOTH_MARKET_ID,
  soothLaunchpad: SOOTH_LAUNCHPAD_ID,
  soothAdjudicator: SOOTH_ADJUDICATOR_ID,
};

// Canonical devnet USDC mint — pinned in every program's `usdc_mint`
// `address = ...` constraint via `sooth_protocol_types::USDC_MINT_DEVNET`.
const USDC_MINT_DEVNET = new PublicKey(
  "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX",
);

const ENV_LOCAL_PATH = resolve(DEMO_ROOT, ".env.local");

function log(msg) {
  process.stdout.write(`[seed-devnet] ${msg}\n`);
}

function die(msg, code = 1) {
  process.stderr.write(`[seed-devnet] ERROR: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    keypair: null,
    rpc: "https://api.devnet.solana.com",
    withMarket: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keypair") {
      out.keypair = argv[++i];
    } else if (a === "--rpc") {
      out.rpc = argv[++i];
    } else if (a === "--with-market") {
      out.withMarket = true;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        `Usage: seed-devnet.mjs --keypair <path> [--rpc <url>] [--with-market]\n`,
      );
      process.exit(0);
    } else {
      die(`unknown arg: ${a}`);
    }
  }
  if (!out.keypair) die("--keypair <path> is required");
  return out;
}

function loadKeypair(path) {
  if (!existsSync(path)) die(`keypair not found: ${path}`);
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}

const { keypair: keypairPath, rpc, withMarket } = parseArgs(process.argv);
const signer = loadKeypair(keypairPath);
log(`signer: ${signer.publicKey.toBase58()}`);
log(`rpc:    ${rpc}`);

const connection = new Connection(rpc, "confirmed");

// Sanity: validator reachable.
try {
  await connection.getVersion();
} catch (e) {
  die(`cannot reach RPC at ${rpc}: ${e.message ?? e}`);
}

const balance = await connection.getBalance(signer.publicKey);
log(`signer balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
if (balance < 0.05 * LAMPORTS_PER_SOL) {
  die(
    `signer needs at least 0.05 SOL on devnet to cover rent + fees; have ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
  );
}

// Sanity: USDC mint exists at the canonical address.
const usdcMintAcc = await connection.getAccountInfo(USDC_MINT_DEVNET);
if (!usdcMintAcc) {
  die(
    `canonical USDC mint not found at ${USDC_MINT_DEVNET.toBase58()} on this RPC`,
  );
}
if (!usdcMintAcc.owner.equals(TOKEN_PROGRAM_ID)) {
  die(
    `USDC mint at ${USDC_MINT_DEVNET.toBase58()} is owned by ${usdcMintAcc.owner.toBase58()}, expected SPL Token`,
  );
}
log(`USDC mint OK at ${USDC_MINT_DEVNET.toBase58()}`);

// Sanity: launchpad + market programs deployed.
for (const [name, id] of [
  ["sooth_launchpad", SOOTH_LAUNCHPAD_ID],
  ["sooth_market", SOOTH_MARKET_ID],
  ["sooth_adjudicator", SOOTH_ADJUDICATOR_ID],
]) {
  const info = await connection.getAccountInfo(id);
  if (!info) die(`${name} not deployed at ${id.toBase58()}`);
  log(`${name} deployed: ${id.toBase58()}`);
}

// AMM is required only for the optional market-seeding step.
const ammInfo = await connection.getAccountInfo(SOOTH_AMM_ID);
if (!ammInfo) {
  log(
    `WARN: sooth_amm (${SOOTH_AMM_ID.toBase58()}) not deployed yet — bootstrap will succeed but --with-market is unavailable`,
  );
  if (withMarket) {
    die("--with-market requires sooth_amm to be deployed");
  }
}

const wallet = {
  publicKey: signer.publicKey,
  signTransaction: async (tx) => {
    tx.partialSign(signer);
    return tx;
  },
  signAllTransactions: async (txs) => {
    for (const tx of txs) tx.partialSign(signer);
    return txs;
  },
  payer: signer,
};
const provider = new AnchorProvider(connection, wallet, {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});

const launchpadProgram = new Program(soothLaunchpadIdl, provider);
const marketProgram = new Program(soothMarketIdl, provider);
const adjudicatorProgram = new Program(soothAdjudicatorIdl, provider);

// ─── 1. ProtocolConfig (singleton) ─────────────────────────────────────────
const [configPda] = deriveProtocolConfigPda({
  soothLaunchpad: SOOTH_LAUNCHPAD_ID,
});
const configInfo = await connection.getAccountInfo(configPda);
if (!configInfo) {
  await launchpadProgram.methods
    .initializeProtocol({
      ammFeeBps: 500,  // 5% — the incubation venue
      bookFeeBps: 100, // 1% — the mature venue
      treasury: signer.publicKey,
      bBaseShareBps: 5_000,
      lpYieldShareBps: 3_000,
      adjudicatorShareBps: 1_000,
      protocolShareBps: 1_000,
      defaultTrialPeriod: new BN(7 * 24 * 60 * 60),
      // 5 minutes on devnet: long enough that the veto window is a real,
      // demonstrable state in the UI (attest -> "in veto window" -> settle),
      // short enough to walk through live. Mainnet uses
      // DEFAULT_VETO_PERIOD_SECS (24h), matching the EVM guardian window.
      vetoPeriodSecs: new BN(300),
    })
    .accounts({
      config: configPda,
      authority: signer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([signer])
    .rpc();
  log(`initializeProtocol OK (config=${configPda.toBase58()})`);
} else {
  log(`ProtocolConfig already present at ${configPda.toBase58()}, skipping`);
}

// ─── 2. fee_pool_vault ATA ─────────────────────────────────────────────────
const [feePoolAuthorityPda] = deriveFeePoolAuthorityPda({
  soothLaunchpad: SOOTH_LAUNCHPAD_ID,
});
const feePoolVault = deriveFeePoolVaultAta(USDC_MINT_DEVNET, {
  soothLaunchpad: SOOTH_LAUNCHPAD_ID,
});
const feePoolVaultInfo = await connection.getAccountInfo(feePoolVault);
if (!feePoolVaultInfo) {
  await launchpadProgram.methods
    .initializeFeePool()
    .accounts({
      feePoolAuthority: feePoolAuthorityPda,
      usdcMint: USDC_MINT_DEVNET,
      feePoolVault,
      signer: signer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([signer])
    .rpc();
  log(`initializeFeePool OK (vault=${feePoolVault.toBase58()})`);
} else {
  log(`fee_pool_vault already present at ${feePoolVault.toBase58()}, skipping`);
}

// ─── 3. AdjudicatorAllowlist ───────────────────────────────────────────────
const [allowlistPda] = deriveAdjudicatorAllowlistPda(PROGRAMS);
const allowlistInfo = await connection.getAccountInfo(allowlistPda);
if (!allowlistInfo) {
  await marketProgram.methods
    .initializeAdjudicatorAllowlist(signer.publicKey)
    .accounts({
      allowlist: allowlistPda,
      signer: signer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([signer])
    .rpc();
  log(
    `initializeAdjudicatorAllowlist OK (authority=${signer.publicKey.toBase58()})`,
  );
} else {
  log(
    `AdjudicatorAllowlist already present at ${allowlistPda.toBase58()}, skipping`,
  );
}

// ─── 4. add_adjudicator (signer doubles as demo adjudicator) ───────────────
const demoAdjudicator = signer.publicKey;
try {
  await marketProgram.methods
    .addAdjudicator(demoAdjudicator)
    .accounts({
      allowlist: allowlistPda,
      authority: signer.publicKey,
    })
    .signers([signer])
    .rpc();
  log(`addAdjudicator OK (adjudicator=${demoAdjudicator.toBase58()})`);
} catch (e) {
  const msg = String(e?.message ?? e);
  if (msg.includes("AdjudicatorAlreadyAllowlisted")) {
    log(
      `adjudicator ${demoAdjudicator.toBase58()} already allow-listed, skipping`,
    );
  } else {
    throw e;
  }
}

// ─── 5. Optional: seed a demo market ───────────────────────────────────────
let seededMarketRef = null;
if (withMarket) {
  const userAta = getAssociatedTokenAddressSync(
    USDC_MINT_DEVNET,
    signer.publicKey,
  );
  const ataInfo = await connection.getAccountInfo(userAta);
  if (!ataInfo) {
    die(
      `--with-market requires a USDC ATA at ${userAta.toBase58()} for the signer; fund it via a devnet USDC source first`,
    );
  }

  const marketId = new Uint8Array(16);
  for (let i = 0; i < 16; i++) marketId[i] = (Math.random() * 256) | 0;
  const [marketPda] = deriveMarketPda(marketId, PROGRAMS);
  const [vaultAuthority] = deriveVaultAuthorityPda(marketId, PROGRAMS);
  const [lockAuthority] = deriveLockAuthorityPda(marketId, PROGRAMS);
  const [yesMint] = deriveYesMintPda(marketId, PROGRAMS);
  const [noMint] = deriveNoMintPda(marketId, PROGRAMS);
  const vault = deriveMarketVaultAta(marketId, USDC_MINT_DEVNET, PROGRAMS);
  const lockVault = deriveLockVaultAta(marketId, USDC_MINT_DEVNET, PROGRAMS);
  const [ammStatePda] = deriveAmmStatePda(marketId, PROGRAMS);
  const startTime = Math.floor(Date.now() / 1000);
  const deadline = startTime + 7 * 24 * 60 * 60;
  const bWad = 1_000n * WAD;

  await launchpadProgram.methods
    .createMarket({
      marketId: Array.from(marketId),
      questionHash: Array(32).fill(0),
      startTime: new BN(startTime),
      deadline: new BN(deadline),
      adjudicator: demoAdjudicator,
      initialB: new BN(bWad.toString()),
    })
    .accounts({
      config: configPda,
      market: marketPda,
      adjudicatorAllowlist: allowlistPda,
      vaultAuthority,
      yesMint,
      noMint,
      lockAuthority,
      usdcMint: USDC_MINT_DEVNET,
      vault,
      lockVault,
      ammState: ammStatePda,
      creator: signer.publicKey,
      soothMarketProgram: SOOTH_MARKET_ID,
      soothAmmProgram: SOOTH_AMM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([signer])
    .rpc();
  log(`createMarket OK (market=${marketPda.toBase58()})`);

  // Register per-market Adjudicator PDA on sooth_adjudicator (Manual variant).
  const [adjudicatorPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("adjudicator"), marketPda.toBuffer()],
    SOOTH_ADJUDICATOR_ID,
  );
  const adjudicatorInfo = await connection.getAccountInfo(adjudicatorPda);
  if (!adjudicatorInfo) {
    await adjudicatorProgram.methods
      .registerAdjudicator(demoAdjudicator, { manual: {} })
      .accounts({
        adjudicator: adjudicatorPda,
        market: marketPda,
        signer: signer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([signer])
      .rpc();
    log(`registerAdjudicator OK (kind=Manual)`);
  } else {
    log(`Adjudicator PDA already present, skipping`);
  }

  seededMarketRef = `sol:${marketPda.toBase58()}`;
}

// ─── Optional: write .env.local for the demo ───────────────────────────────
const envBody = [
  "# Auto-generated by apps/demo/scripts/seed-devnet.mjs.",
  "# Override defaults from src/lib/config.ts. Do not commit.",
  "",
  `VITE_SOLANA_RPC_URL=${rpc}`,
  `VITE_SOOTH_AMM_ID=${SOOTH_AMM_ID.toBase58()}`,
  `VITE_SOOTH_MARKET_ID=${SOOTH_MARKET_ID.toBase58()}`,
  `VITE_SOOTH_ADJUDICATOR_ID=${SOOTH_ADJUDICATOR_ID.toBase58()}`,
  `VITE_USDC_MINT=${USDC_MINT_DEVNET.toBase58()}`,
  seededMarketRef
    ? `VITE_DEMO_MARKET_REF=${seededMarketRef}`
    : `# VITE_DEMO_MARKET_REF= (not seeded; pass --with-market once funded with USDC)`,
  "",
].join("\n");
writeFileSync(ENV_LOCAL_PATH, envBody);
log(`wrote ${ENV_LOCAL_PATH}`);

log("");
log("=== Devnet seed complete ===");
log(`config:            ${configPda.toBase58()}`);
log(`fee_pool_vault:    ${feePoolVault.toBase58()}`);
log(`allowlist:         ${allowlistPda.toBase58()}`);
log(`adjudicator:       ${demoAdjudicator.toBase58()}`);
if (seededMarketRef) log(`market ref:        ${seededMarketRef}`);
