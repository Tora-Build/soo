#!/usr/bin/env node
// Creates ONE devnet market wired to Primus' real global attestor, and prints
// the `infra/zk-resolver/markets.json` entry that watches it.
//
//     node scripts/zk-primus-market.mjs
//     node scripts/zk-primus-market.mjs --deadline 120 --margin 1000 --scale 8
//
// The difference from `zk-attest-devnet.mjs` — which proves the same path with
// a LOCAL attestor key generated per run — is the one field that cannot be
// changed afterwards:
//
//     attestor_evm = 0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6
//
// Every attestation the Primus network returns is signed by that address
// (`PADOADDRESS`, hardcoded in `@primuslabs/zktls-core-sdk`). `appId` and
// `appSecret` authenticate a caller and sign the REQUEST; they never sign the
// attestation. `register_zk_adjudicator` writes `zk_attestor_evm` once, so a
// market registered to anything else can never be resolved by a real Primus
// attestation. This script therefore does not accept an attestor argument.
//
// It attests nothing. The resolver in `infra/zk-resolver/` does that, which is
// the point: this script's whole job is to leave a market on chain that the
// service can pick up from its registry.
//
// `value_scale` defaults to 8 rather than the mock-USDC 6 used elsewhere,
// because the program REJECTS an attested value carrying more fractional
// digits than the registered scale, and Coinbase's spot amount varies between
// two and three decimals reading to reading. Eight is headroom, not precision.
//
// No emojis in script output (project rule).

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import anchor from "@coral-xyz/anchor";
const { AnchorProvider, BN, Program } = anchor;

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(DEMO_ROOT, "..", "..");
const SDK_DIST = resolve(REPO_ROOT, "packages", "sdk-solana", "dist");
const sdkUrl = (rel) => new URL(`file://${SDK_DIST}/${rel}`).href;

const { SolanaChainAdapter } = await import(sdkUrl("adapter.js"));
const { computeRuleHash, ZK_COMPARATOR } = await import(sdkUrl("zk.js"));
const { soothCoreIdl } = await import(sdkUrl("anchor/index.js"));
const {
  deriveAdjudicatorEntryPda,
  deriveAmmStatePda,
  deriveFeePoolAuthorityPda,
  deriveLockAuthorityPda,
  deriveLockVaultAta,
  deriveMarketPda,
  deriveMarketVaultAmm,
  deriveMarketVaultAta,
  deriveProtocolConfigPda,
  deriveVaultAuthorityPda,
  feePoolAmmPda,
  feePoolBookPda,
  SOOTH_CORE_PROGRAM_ID,
} = await import(sdkUrl("pdas.js"));

// ── Configuration ──────────────────────────────────────────────────────────

/** Primus' global attestor. Not configurable — see the header. */
const PADO_ATTESTOR = "0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6";

const ENV_LOCAL_PATH = resolve(DEMO_ROOT, ".env.local");
const RESOLVER_ENV_PATH = resolve(REPO_ROOT, "infra", "zk-resolver", ".env");

const VENUE_MINT = new PublicKey("ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX");

const FEED_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
const FEED_PARSE_PATH = "$.data.amount";
const FEED_KEY_NAME = "amount";
const FEED_PARSE_TYPE = "string";

const args = parseArgs(process.argv.slice(2));

const VALUE_SCALE = args.scale;
const THRESHOLD_MARGIN_USD = BigInt(args.margin);
const DEADLINE_SECS = args.deadline;
const B_WAD = 10n ** 18n;

const SOOTH_CORE_ID = soothCoreIdl.address
  ? new PublicKey(soothCoreIdl.address)
  : SOOTH_CORE_PROGRAM_ID;
const PROGRAMS = { soothCore: SOOTH_CORE_ID };

function parseArgs(argv) {
  const out = { deadline: 90, margin: 1000, scale: 8, comparator: "Gt" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    if (a === "--deadline") out.deadline = Number(take());
    else if (a === "--margin") out.margin = Number(take());
    else if (a === "--scale") out.scale = Number(take());
    else if (a === "--comparator") out.comparator = take();
    else fail(`unknown argument ${a}`);
  }
  return out;
}

// ── Output ─────────────────────────────────────────────────────────────────

const log = (msg) => process.stdout.write(`[zk-primus-market] ${msg}\n`);
const step = (msg) => process.stdout.write(`\n[zk-primus-market] === ${msg} ===\n`);
function fail(msg) {
  process.stderr.write(`[zk-primus-market] ERROR: ${msg}\n`);
  process.exit(1);
}

const heapFrameIx = () => ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 });
const cuLimitIx = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Send and confirm over HTTP only; see the note in `zk-attest-devnet.mjs`. */
async function sendAndConfirm(connection, tx, signers) {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  for (let i = 0; i < 60; i++) {
    const st = (
      await connection.getSignatureStatuses([sig], { searchTransactionHistory: true })
    ).value?.[0];
    if (st?.err) {
      const err = new Error(`transaction ${sig} failed`);
      err.signature = sig;
      err.txErr = st.err;
      throw err;
    }
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      return sig;
    }
    await sleep(1000);
  }
  throw new Error(`transaction ${sig} not confirmed after 60s`);
}

function ixFromMeta(meta) {
  return new TransactionInstruction({
    programId: new PublicKey(meta.ixProgramId),
    keys: meta.ixKeys.map((k) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(meta.ixData, "base64"),
  });
}

/**
 * A decimal string to fixed point at `10^scale`, rejecting excess precision
 * rather than truncating — the rule `parse_fixed_point` applies on chain.
 */
function toFixedPoint(decimal, scale) {
  const [intPart, fracPart = ""] = String(decimal).split(".");
  if (!/^\d+$/.test(intPart) || (fracPart && !/^\d+$/.test(fracPart))) {
    fail(`feed returned a non-decimal value: ${JSON.stringify(decimal)}`);
  }
  if (fracPart.length > scale) {
    fail(`feed value ${decimal} carries ${fracPart.length} decimals, more than scale ${scale}`);
  }
  return BigInt(intPart + fracPart.padEnd(scale, "0"));
}

async function fetchFeed() {
  const res = await fetch(FEED_URL, { headers: { accept: "application/json" } });
  if (!res.ok) fail(`feed ${FEED_URL} returned HTTP ${res.status}`);
  const body = await res.json();
  const raw = body?.data?.amount;
  if (typeof raw !== "string") {
    fail(`feed response has no string at ${FEED_PARSE_PATH}: ${JSON.stringify(body)}`);
  }
  return { raw, scaled: toFixedPoint(raw, VALUE_SCALE), body };
}

function readDotenv(path, required = true) {
  if (!existsSync(path)) {
    if (required) fail(`${path} not found`);
    return {};
  }
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function keypairFrom(raw, name) {
  if (!raw) fail(`${name} is missing`);
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[")) fail(`${name} must be a JSON byte array`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  step("preflight");

  const demoEnv = readDotenv(ENV_LOCAL_PATH);
  const resolverEnv = readDotenv(RESOLVER_ENV_PATH, false);
  const rpcUrl =
    process.env.SOLANA_RPC_URL ??
    resolverEnv.SOLANA_RPC_URL ??
    "https://api.devnet.solana.com";

  const creator = keypairFrom(demoEnv.VITE_TEST_AUTHORITY_BYTES, "VITE_TEST_AUTHORITY_BYTES");

  // The adjudicator `authority` is what `request_lock` is signer-gated on, so
  // it must be the key the resolver runs with — otherwise the resolver can
  // read the market as due and still be unable to move it out of `Open`.
  const resolverKey = resolverEnv.RESOLVER_KEYPAIR
    ? keypairFrom(resolverEnv.RESOLVER_KEYPAIR, "RESOLVER_KEYPAIR")
    : null;
  const adjudicatorAuthority = resolverKey ? resolverKey.publicKey : creator.publicKey;

  log(`rpc:                   ${rpcUrl}`);
  log(`program:               ${SOOTH_CORE_ID.toBase58()}`);
  log(`creator:               ${creator.publicKey.toBase58()}`);
  log(`adjudicator authority: ${adjudicatorAuthority.toBase58()}${resolverKey ? " (RESOLVER_KEYPAIR)" : " (creator; resolver cannot lock)"}`);
  log(`attestor_evm:          ${PADO_ATTESTOR} (Primus global attestor)`);

  const connection = new Connection(rpcUrl, "confirmed");
  const version = await connection
    .getVersion()
    .catch((e) => fail(`cannot reach ${rpcUrl}: ${e.message}`));
  log(`solana-core ${version["solana-core"]}`);

  const wallet = {
    publicKey: creator.publicKey,
    signTransaction: async (tx) => (tx.partialSign(creator), tx),
    signAllTransactions: async (txs) => (txs.forEach((t) => t.partialSign(creator)), txs),
    payer: creator,
  };
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program({ ...soothCoreIdl, address: SOOTH_CORE_ID.toBase58() }, provider);

  const [configPda] = deriveProtocolConfigPda(PROGRAMS);
  const config = await program.account.protocolConfig.fetch(configPda);
  const permissionless = config.permissionless_adjudicators ?? config.permissionlessAdjudicators;
  log(`protocol config: permissionless_adjudicators=${permissionless}, authority=${config.authority.toBase58()}`);
  if (!permissionless && !config.authority.equals(creator.publicKey)) {
    fail("adjudicator registration is permissioned and the creator is not the protocol authority");
  }

  const bal = await connection.getBalance(creator.publicKey);
  log(`creator balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (bal < 0.1 * LAMPORTS_PER_SOL) fail("creator is out of SOL");

  const adapter = new SolanaChainAdapter({
    node: {
      id: "devnet",
      chainKind: "solana",
      chainId: "devnet",
      cluster: "devnet",
      rpcUrl,
      programs: {
        soothCore: SOOTH_CORE_ID.toBase58(),
        usdcMint: VENUE_MINT.toBase58(),
        ammMint: VENUE_MINT.toBase58(),
      },
    },
    connection,
  });

  // ── The rule ────────────────────────────────────────────────────────────
  step("endpoint and rule");
  const preview = await fetchFeed();
  log(`${FEED_URL} -> ${FEED_PARSE_PATH} = ${preview.raw}`);
  const comparator = ZK_COMPARATOR[args.comparator];
  if (!comparator) fail(`unknown comparator ${args.comparator}`);

  // A margin below spot, so the GT predicate has one answer regardless of
  // where the price sits by the time Primus observes it.
  const threshold =
    preview.scaled - THRESHOLD_MARGIN_USD * 10n ** BigInt(VALUE_SCALE);
  if (threshold <= 0n) fail(`feed value ${preview.raw} is below the chosen margin`);

  const ruleHash = await computeRuleHash(FEED_URL, FEED_PARSE_PATH);
  const thresholdDisplay = formatFixed(threshold, VALUE_SCALE);
  log(`rule: value ${args.comparator} ${thresholdDisplay} at scale ${VALUE_SCALE}`);
  log(`rule_hash: 0x${hex(ruleHash)}`);

  // ── The market ──────────────────────────────────────────────────────────
  step("creating the market");
  const marketId = Uint8Array.from(randomBytes(16));
  const [marketPda] = deriveMarketPda(marketId, PROGRAMS);
  const [vaultAuthority] = deriveVaultAuthorityPda(marketId, PROGRAMS);
  const [lockAuthority] = deriveLockAuthorityPda(marketId, PROGRAMS);
  const [ammStatePda] = deriveAmmStatePda(marketId, PROGRAMS);
  const [adjudicatorPda] = deriveAdjudicatorEntryPda(marketPda, PROGRAMS);

  const startTime = Math.floor(Date.now() / 1000);
  const deadline = startTime + DEADLINE_SECS;
  const question =
    `Primus zkTLS devnet: will BTC-USD spot exceed ${thresholdDisplay} USD at deadline?`;

  log(`market:            ${marketPda.toBase58()}`);
  log(`adjudicator entry: ${adjudicatorPda.toBase58()}`);
  log(`deadline:          ${deadline} (${new Date(deadline * 1000).toISOString()}, ${DEADLINE_SECS}s out)`);

  const createSig = await sendAndConfirm(
    connection,
    await program.methods
      .createMarket({
        marketId: Array.from(marketId),
        question,
        questionHash: Array.from(createHash("sha256").update(question, "utf8").digest()),
        startTime: new BN(startTime),
        deadline: new BN(deadline),
        adjudicator: adjudicatorAuthority,
        initialB: new BN(B_WAD.toString()),
      })
      .accounts({
        config: configPda,
        market: marketPda,
        vaultAuthority,
        lockAuthority,
        bookMint: VENUE_MINT,
        ammMint: VENUE_MINT,
        vaultBook: deriveMarketVaultAta(marketId, VENUE_MINT, PROGRAMS),
        vaultAmm: deriveMarketVaultAmm(marketId, PROGRAMS),
        lockVault: deriveLockVaultAta(marketId, VENUE_MINT, PROGRAMS),
        ammState: ammStatePda,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([cuLimitIx(), heapFrameIx()])
      .transaction(),
    [creator],
  );
  log(`createMarket ${createSig}`);

  step("register_zk_adjudicator");
  const req = await adapter.buildRegisterZkAdjudicator(`sol:${marketPda.toBase58()}`, {
    user: `sol:${creator.publicKey.toBase58()}`,
    authority: `sol:${adjudicatorAuthority.toBase58()}`,
    attestorEvm: PADO_ATTESTOR,
    ruleHash,
    comparator,
    threshold,
    valueScale: VALUE_SCALE,
  });
  const registerSig = await sendAndConfirm(
    connection,
    new Transaction().add(heapFrameIx(), ixFromMeta(req.meta)),
    [creator],
  );
  log(`registerZkAdjudicator ${registerSig}`);

  await seedMarket({ connection, program, creator }, marketId, marketPda, ammStatePda, configPda);

  // ── Read back ───────────────────────────────────────────────────────────
  step("reading the AdjudicatorEntry back");
  const entry = await program.account.adjudicatorEntry.fetch(adjudicatorPda);
  const onChainAttestor = `0x${hex(Uint8Array.from(entry.zk_attestor_evm ?? entry.zkAttestorEvm))}`;
  const onChainRuleHash = `0x${hex(Uint8Array.from(entry.zk_rule_hash ?? entry.zkRuleHash))}`;
  const onChainThreshold = BigInt((entry.zk_threshold ?? entry.zkThreshold).toString());
  const onChainScale = entry.zk_value_scale ?? entry.zkValueScale;
  const onChainComparator = entry.zk_comparator ?? entry.zkComparator;
  log(`authority:        ${entry.authority.toBase58()}`);
  log(`attestor_evm:     ${onChainAttestor}`);
  log(`rule_hash:        ${onChainRuleHash}`);
  log(`comparator:       ${args.comparator} (${onChainComparator})`);
  log(`value_scale:      ${onChainScale}`);
  log(`threshold:        ${formatFixed(onChainThreshold, onChainScale)} (raw ${onChainThreshold})`);
  log(`attested_outcome: ${entry.attested_outcome ?? entry.attestedOutcome ?? "none"}`);

  if (onChainAttestor.toLowerCase() !== PADO_ATTESTOR.toLowerCase()) {
    fail(`registered attestor ${onChainAttestor} is not the Primus attestor — this market cannot be resolved by Primus`);
  }

  // ── The registry entry ──────────────────────────────────────────────────
  step("infra/zk-resolver/markets.json entry");
  process.stdout.write(
    `${JSON.stringify(
      {
        market: marketPda.toBase58(),
        label: "btc-spot-primus",
        url: FEED_URL,
        parsePath: FEED_PARSE_PATH,
        keyName: FEED_KEY_NAME,
        parseType: FEED_PARSE_TYPE,
      },
      null,
      2,
    )}\n`,
  );

  step("next");
  log(`wait until ${new Date(deadline * 1000).toISOString()}, then:`);
  log(`  cd infra/zk-resolver && node src/index.mjs --once --plan --only ${marketPda.toBase58()}`);
  log(`  cd infra/zk-resolver && node src/index.mjs --once --only ${marketPda.toBase58()}`);
}

/** `seed_lp` + `init_market_fee_pool`. Consistency, not a precondition. */
async function seedMarket(ctx, marketId, marketPda, ammStatePda, configPda) {
  const { connection, program, creator } = ctx;
  try {
    const pda = (seed, extra = []) =>
      PublicKey.findProgramAddressSync([Buffer.from(seed), ...extra], SOOTH_CORE_ID)[0];
    const lpMintPda = pda("lp", [Buffer.from(marketId)]);
    await program.methods
      .seedLp({
        lpAmount: new BN((B_WAD / 1_000_000_000_000n).toString()),
        seedDepositWad: new BN(
          ((B_WAD * 693_147_180_559_945_309n) / 1_000_000_000_000_000_000n).toString(),
        ),
      })
      .accounts({
        config: configPda,
        market: marketPda,
        ammState: ammStatePda,
        lpMint: lpMintPda,
        lpMintAuthority: pda("lp_mint_authority", [Buffer.from(marketId)]),
        creatorLpAta: getAssociatedTokenAddressSync(lpMintPda, creator.publicKey),
        lpPosition: pda("lp_position", [Buffer.from(marketId), creator.publicKey.toBuffer()]),
        marketVault: deriveMarketVaultAmm(marketId, PROGRAMS),
        creatorAmmAta: getAssociatedTokenAddressSync(VENUE_MINT, creator.publicKey),
        ammMint: VENUE_MINT,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([heapFrameIx()])
      .transaction()
      .then((tx) => sendAndConfirm(connection, tx, [creator]));

    const [feePoolAuthorityPda] = deriveFeePoolAuthorityPda(PROGRAMS);
    await program.methods
      .initMarketFeePool()
      .accounts({
        market: marketPda,
        feePoolAuthority: feePoolAuthorityPda,
        bookMint: VENUE_MINT,
        ammMint: VENUE_MINT,
        feePoolBook: feePoolBookPda(marketId, PROGRAMS)[0],
        feePoolAmm: feePoolAmmPda(marketId, PROGRAMS)[0],
        lpYieldAuthority: pda("lp_yield_authority"),
        lpYieldAmm: pda("lp_yield_amm", [Buffer.from(marketId)]),
        lpYieldBook: pda("lp_yield_book", [Buffer.from(marketId)]),
        signer: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([heapFrameIx()])
      .transaction()
      .then((tx) => sendAndConfirm(connection, tx, [creator]));
    log("seedLp + initMarketFeePool OK");
  } catch (err) {
    log(`WARNING seed_lp/init_market_fee_pool skipped — ${String(err?.message ?? err).slice(0, 200)}`);
  }
}

function formatFixed(value, scale) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const frac = scale > 0 ? `.${digits.slice(digits.length - scale)}` : "";
  return `${negative ? "-" : ""}${int}${frac}`;
}

main().catch((err) => {
  process.stderr.write(`[zk-primus-market] UNCAUGHT: ${err?.stack ?? err}\n`);
  if (err?.logs) process.stderr.write(`${err.logs.join("\n")}\n`);
  process.exit(1);
});
