#!/usr/bin/env node
// End-to-end proof, on DEVNET, that `sooth_core` verifies a Primus-style
// zkTLS attestation — not a unit test, not litesvm, the deployed program.
//
//     SOLANA_RPC_URL=https://api.devnet.solana.com node scripts/zk-attest-devnet.mjs
//
// What it proves, in one run:
//
//   POSITIVE  A fresh market commits to a real public price endpoint. A
//             secp256k1 key generated in this process (standing in for a
//             Primus attestor) signs an attestation carrying the price this
//             script actually fetched from that endpoint, encoded exactly the
//             way `zk/primus.rs` re-encodes it on chain. `attest_outcome_zk`
//             lands, and the AdjudicatorEntry read back afterwards carries the
//             outcome the comparator implies for that price.
//
//   NEGATIVE  A second fresh market, registered to the SAME attestor, is
//             handed (a) an attestation signed by a key it never registered
//             and (b) an attestation whose `data` was edited after signing.
//             Both must be REJECTED on chain. A rejection is the pass
//             condition here; the market is left unattested.
//
// Nothing here touches the demo's existing markets: every market is created
// fresh under a random 16-byte market id and is never written into
// `.env.local`.
//
// The script only READS credentials from `apps/demo/.env.local`. The attestor
// key is generated per run and thrown away — the point is that the program
// accepts a signature it can recover to a registered address, not that any
// particular key is special.
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

// ── Dependencies ───────────────────────────────────────────────────────────
//
// Deep filesystem imports for the same reason `seed-localnet.mjs` uses them:
// the SDK's `exports` map has no subpaths, and the package root pulls in
// `@coral-xyz/anchor` named exports which plain `node` cannot parse out of a
// CJS module. `adapter.js` and `zk.js` load cleanly this way.
const { SolanaChainAdapter } = await import(sdkUrl("adapter.js"));
const { computeRuleHash, toZkAttestationArg, ZK_COMPARATOR } = await import(
  sdkUrl("zk.js")
);
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

// secp256k1 + keccak256. Neither is an `apps/demo` dependency, but both are
// already installed for `@sooth/sdk-solana` (its devDependencies), so they are
// on disk in this workspace and nothing new needs installing. Resolved by path
// because pnpm's strict layout keeps them out of this package's lookup chain.
const NOBLE_ROOT = resolve(
  REPO_ROOT,
  "packages",
  "sdk-solana",
  "node_modules",
  "@noble",
);
if (!existsSync(NOBLE_ROOT)) {
  fail(
    `@noble packages not found at ${NOBLE_ROOT} — run \`pnpm install\` at the repo root`,
  );
}
const { secp256k1 } = await import(
  new URL(`file://${NOBLE_ROOT}/curves/esm/secp256k1.js`).href
);
const { keccak_256 } = await import(
  new URL(`file://${NOBLE_ROOT}/hashes/esm/sha3.js`).href
);

// ── Configuration ──────────────────────────────────────────────────────────

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ENV_LOCAL_PATH = resolve(DEMO_ROOT, ".env.local");

// Both venue roles are filled by the same mock-USDC mint on this deployment.
const VENUE_MINT = new PublicKey("ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX");

// The program installs a 256 KB `#[global_allocator]`; the runtime only maps
// that region when the transaction asks for it. Every transaction below
// prepends this — the hard invariant in CLAUDE.md.
const heapFrameIx = () =>
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 });

// `secp256k1_recover` plus three keccak passes sit well inside this; the
// default 200k is enough today but the margin is free.
const cuLimitIx = () =>
  ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

// The real endpoint the markets commit to. No auth, no key, stable shape,
// and a value that moves — so the attested number is visibly a live reading
// rather than a constant baked into this file.
const FEED_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
const FEED_HEADER = '{"accept":"application/json"}';
const FEED_METHOD = "GET";
const FEED_PARSE_PATH = "$.data.amount";
const FEED_KEY_NAME = "amount";
const FEED_PARSE_TYPE = "string";
// Six decimal places, matching the mock-USDC scale used everywhere else here.
const VALUE_SCALE = 6;
// How far below spot the YES threshold sits, so the GT predicate has an
// unambiguous answer even if the price moves between the two fetches.
const THRESHOLD_MARGIN_USD = 1_000n;
// Trading window. Short because the attestation timestamp must be at or after
// the deadline, and `request_lock` refuses before it.
const DEADLINE_SECS = Number(process.env.ZK_DEADLINE_SECS ?? 25);
// Liquidity parameter. Small on purpose: the creator posts `b * ln(2)` as the
// LMSR subsidy in `seed_lp`, and this proof does not need a deep book.
const B_WAD = BigInt(process.env.ZK_B_WAD ?? "1") * 10n ** 18n;

// Anchor error codes, from the IDL. Named here so a failure reports what the
// program actually said rather than a bare hex code.
const ZK_ERRORS = Object.fromEntries(
  (soothCoreIdl.errors ?? []).map((e) => [e.code, e.name]),
);

const SOOTH_CORE_ID = soothCoreIdl.address
  ? new PublicKey(soothCoreIdl.address)
  : SOOTH_CORE_PROGRAM_ID;
const PROGRAMS = { soothCore: SOOTH_CORE_ID };

// ── Output ─────────────────────────────────────────────────────────────────

const results = [];
function log(msg) {
  process.stdout.write(`[zk-attest] ${msg}\n`);
}
function step(msg) {
  process.stdout.write(`\n[zk-attest] === ${msg} ===\n`);
}
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(msg) {
  process.stderr.write(`[zk-attest] ERROR: ${msg}\n`);
  process.exit(1);
}

// ── Transaction plumbing ───────────────────────────────────────────────────

/**
 * Send and confirm over HTTP only.
 *
 * The Alchemy proxy this repo normally points at has no `signatureSubscribe`
 * on its free tier, and web3.js derives the websocket URL from the HTTP one —
 * so `confirmTransaction` never gets its notification and reports an expiry
 * for a transaction that in fact landed. Polling `getSignatureStatuses` is the
 * same pattern `seed-localnet.mjs` falls back to, promoted here to the only
 * path so the script behaves identically on either endpoint.
 */
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
      await connection.getSignatureStatuses([sig], {
        searchTransactionHistory: true,
      })
    ).value?.[0];
    if (st?.err) {
      const err = new Error(`transaction ${sig} failed`);
      err.signature = sig;
      err.txErr = st.err;
      throw err;
    }
    if (
      st &&
      (st.confirmationStatus === "confirmed" ||
        st.confirmationStatus === "finalized")
    ) {
      return sig;
    }
    await sleep(1000);
  }
  throw new Error(`transaction ${sig} not confirmed after 60s`);
}

/** A `TransactionInstruction` rebuilt from an SDK builder's returned meta. */
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
 * The anchor error code a failed send carried, or `null`.
 *
 * Preflight rejections surface the code in the simulation logs; a landed-then-
 * failed transaction surfaces it in `err.txErr.InstructionError`. Both shapes
 * are read, because which one you get depends on whether preflight ran.
 */
function anchorErrorCode(err) {
  const custom = err?.txErr?.InstructionError?.[1]?.Custom;
  if (typeof custom === "number") return custom;
  const logs = err?.logs ?? err?.transactionLogs ?? [];
  const text = `${err?.transactionMessage ?? ""} ${err?.message ?? ""} ${logs.join(" ")}`;
  const hex = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hex) return Number.parseInt(hex[1], 16);
  const dec = text.match(/Error Number: (\d+)/);
  if (dec) return Number.parseInt(dec[1], 10);
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── EVM-side crypto ────────────────────────────────────────────────────────
//
// Mirrors `zk/primus.rs`. Everything here is re-derived on chain from the
// structured fields, so a mistake shows up as a verification failure rather
// than a forged outcome — which is exactly what makes the negative cases below
// meaningful.

const enc = new TextEncoder();
const hex = (bytes) => Buffer.from(bytes).toString("hex");

/** The low 20 bytes of `keccak256(uncompressed pubkey without its 0x04 tag)`. */
function evmAddress(privKey) {
  const pub = secp256k1.getPublicKey(privKey, false).slice(1);
  return keccak_256(pub).slice(12);
}

function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u64be(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}

/**
 * `PrimusZKTLS.encodeAttestation` — the 32 bytes an attestor signs.
 *
 * `abi.encodePacked`: no length prefixes, no padding, no offsets, and the
 * `Attestor[]` / `signatures[]` members are outside the digest. The timestamp
 * is a `uint64` big-endian. The byte-for-byte counterpart is
 * `ZkAttestation::encode` in `zk/primus.rs`.
 */
function encodeAttestation(att) {
  const requestHash = keccak_256(
    concatBytes(
      enc.encode(att.request.url),
      enc.encode(att.request.header),
      enc.encode(att.request.method),
      enc.encode(att.request.body),
    ),
  );
  const responseHash = keccak_256(
    concatBytes(
      ...att.reponseResolve.flatMap((r) => [
        enc.encode(r.keyName),
        enc.encode(r.parseType),
        enc.encode(r.parsePath),
      ]),
    ),
  );
  return keccak_256(
    concatBytes(
      hexToBytes20(att.recipient),
      requestHash,
      responseHash,
      enc.encode(att.data),
      enc.encode(att.attConditions),
      u64be(att.timestamp),
      enc.encode(att.additionParams),
    ),
  );
}

function hexToBytes20(s) {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(Buffer.from(body, "hex"));
}

/**
 * Signs a digest RAW — no EIP-191 prefix — in EVM wire layout `r ‖ s ‖ v`
 * with `v = recovery_id + 27`, which is what `verifyAttestation` recovers and
 * what `recover_evm_signer` in `zk/primus.rs` expects.
 *
 * noble normalizes `s` to the low half of the order, so the program's explicit
 * malleability check never fires on anything produced here.
 */
function signDigest(privKey, digest) {
  const sig = secp256k1.sign(digest, privKey, { prehash: false });
  const out = new Uint8Array(65);
  out.set(sig.toBytes ? sig.toBytes("compact") : sig.toCompactRawBytes(), 0);
  out[64] = sig.recovery + 27;
  return out;
}

/**
 * The reference vector from `zk/primus.rs`'s `test_support::golden_attestation`,
 * which was itself produced by Primus' own `encodeAttestation` under ethers.
 *
 * Checked before anything touches the network: if this script's encoder has
 * drifted from the program's, every attestation below would be rejected and
 * the negative cases would "pass" for the wrong reason. Failing here instead
 * says which side is wrong.
 */
function selfTestEncoding() {
  const key = new Uint8Array(32).fill(0x11);
  const addr = hex(evmAddress(key));
  if (addr !== "19e7e376e7c213b7e7e7e46cc70a5dd086daff2a") {
    fail(`EVM address derivation drifted: got 0x${addr}`);
  }
  const golden = {
    recipient: "0x00000000000000000000000000000000000000aa",
    request: {
      url: "https://api.example.com/v1/price?symbol=BTCUSDT",
      header: '{"accept":"application/json"}',
      method: "GET",
      body: "",
    },
    reponseResolve: [
      { keyName: "price", parseType: "string", parsePath: "$.data.price" },
    ],
    data: '{"price":"64000.5"}',
    attConditions: '[{"op":">","value":"0"}]',
    timestamp: 1_755_000_000_000n,
    additionParams: "",
  };
  const digest = hex(encodeAttestation(golden));
  if (digest !== "c68a3dba3e6ea0454ad3cc9e08d70d47a1ad2054a0f0799416f832a320ce439a") {
    fail(`encodeAttestation drifted from the Primus reference vector: ${digest}`);
  }
  const sig = hex(signDigest(key, encodeAttestation(golden)));
  const expected =
    "d14f64647879cfe5fbc39bda3efc561b85ed3a55b21dda7266531127715bd18b" +
    "4edc850c5c54247cd167b19ba58a0c6ec1e0a9ad8e0d7a2500fde6646fd80661" +
    "1c";
  if (sig !== expected) {
    fail(`signature layout drifted from the reference vector: ${sig}`);
  }
  record(
    "encoder matches the Primus reference vector",
    true,
    `digest=0x${digest.slice(0, 16)}... addr=0x${addr.slice(0, 8)}...`,
  );
}

// ── Value handling ─────────────────────────────────────────────────────────

/**
 * A decimal string to fixed point at `10^scale`, rejecting excess precision
 * rather than truncating — the same rule `parse_fixed_point` applies on chain,
 * so a value this script accepts is a value the program accepts.
 */
function toFixedPoint(decimal, scale) {
  const [intPart, fracPart = ""] = decimal.split(".");
  if (!/^\d+$/.test(intPart) || (fracPart && !/^\d+$/.test(fracPart))) {
    fail(`feed returned a non-decimal value: ${JSON.stringify(decimal)}`);
  }
  if (fracPart.length > scale) {
    fail(
      `feed value ${decimal} carries ${fracPart.length} decimals, more than scale ${scale}`,
    );
  }
  return BigInt(intPart + fracPart.padEnd(scale, "0"));
}

/** Fetches the endpoint the markets commit to, and reads the committed field. */
async function fetchFeed() {
  const res = await fetch(FEED_URL, {
    method: FEED_METHOD,
    headers: { accept: "application/json" },
  });
  if (!res.ok) fail(`feed ${FEED_URL} returned HTTP ${res.status}`);
  const body = await res.json();
  // Hand-walking `$.data.amount` rather than pulling a JSONPath library in:
  // the path is a constant here, and the program never evaluates it — it only
  // hashes the string into the rule commitment.
  const raw = body?.data?.amount;
  if (typeof raw !== "string") {
    fail(`feed response has no string at ${FEED_PARSE_PATH}: ${JSON.stringify(body)}`);
  }
  return { raw, scaled: toFixedPoint(raw, VALUE_SCALE), body };
}

// ── Market creation ────────────────────────────────────────────────────────

/**
 * A fresh market, its zk adjudicator entry, and the LP seed — everything a
 * zk-adjudicated market needs before it can be locked and attested.
 *
 * The market id is random, so this never collides with the demo's markets and
 * is never written into `.env.local`. `seed_lp` and `init_market_fee_pool` are
 * not required to attest; they run so the market matches the shape every other
 * seeded market has, and a failure in either is reported without failing the
 * proof.
 */
async function createZkMarket(ctx, label, rule) {
  const marketId = Uint8Array.from(randomBytes(16));
  const [marketPda] = deriveMarketPda(marketId, PROGRAMS);
  const [vaultAuthority] = deriveVaultAuthorityPda(marketId, PROGRAMS);
  const [lockAuthority] = deriveLockAuthorityPda(marketId, PROGRAMS);
  const [ammStatePda] = deriveAmmStatePda(marketId, PROGRAMS);
  const [configPda] = deriveProtocolConfigPda(PROGRAMS);
  const [adjudicatorPda] = deriveAdjudicatorEntryPda(marketPda, PROGRAMS);

  const startTime = Math.floor(Date.now() / 1000);
  const deadline = startTime + DEADLINE_SECS;
  const question =
    `zkTLS devnet proof (${label}): will BTC-USD spot exceed ` +
    `${(Number(rule.threshold) / 10 ** VALUE_SCALE).toFixed(2)} USD at deadline?`;

  log(`${label}: creating market ${marketPda.toBase58()}`);
  const createTx = await ctx.program.methods
    .createMarket({
      marketId: Array.from(marketId),
      question,
      questionHash: Array.from(
        createHash("sha256").update(question, "utf8").digest(),
      ),
      startTime: new BN(startTime),
      deadline: new BN(deadline),
      // `Market.adjudicator` is the create-time name; the per-market
      // AdjudicatorEntry registered next is what actually resolves.
      adjudicator: ctx.authority.publicKey,
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
      creator: ctx.authority.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([cuLimitIx(), heapFrameIx()])
    .transaction();
  const createSig = await sendAndConfirm(ctx.connection, createTx, [ctx.authority]);
  log(`${label}: createMarket ${createSig}`);

  // ── register_zk_adjudicator, through the SDK builder ────────────────────
  const req = await ctx.adapter.buildRegisterZkAdjudicator(
    `sol:${marketPda.toBase58()}`,
    {
      user: `sol:${ctx.authority.publicKey.toBase58()}`,
      authority: `sol:${ctx.authority.publicKey.toBase58()}`,
      attestorEvm: rule.attestorEvm,
      ruleHash: rule.ruleHash,
      comparator: ZK_COMPARATOR.Gt,
      threshold: rule.threshold,
      valueScale: VALUE_SCALE,
    },
  );
  const registerSig = await sendAndConfirm(
    ctx.connection,
    new Transaction().add(heapFrameIx(), ixFromMeta(req.meta)),
    [ctx.authority],
  );
  log(`${label}: registerZkAdjudicator ${registerSig}`);

  await seedMarket(ctx, label, marketId, marketPda, ammStatePda, configPda);

  return { label, marketId, marketPda, adjudicatorPda, deadline, question, createSig, registerSig };
}

/** `seed_lp` + `init_market_fee_pool`. Consistency, not a precondition. */
async function seedMarket(ctx, label, marketId, marketPda, ammStatePda, configPda) {
  try {
    const [lpMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp"), Buffer.from(marketId)],
      SOOTH_CORE_ID,
    );
    const [lpMintAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint_authority"), Buffer.from(marketId)],
      SOOTH_CORE_ID,
    );
    const [lpPositionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        Buffer.from(marketId),
        ctx.authority.publicKey.toBuffer(),
      ],
      SOOTH_CORE_ID,
    );
    await ctx.program.methods
      .seedLp({
        lpAmount: new BN((B_WAD / 1_000_000_000_000n).toString()),
        // Exactly the LMSR worst-case subsidy the program requires: b * ln(2).
        seedDepositWad: new BN(
          (
            (B_WAD * 693_147_180_559_945_309n) /
            1_000_000_000_000_000_000n
          ).toString(),
        ),
      })
      .accounts({
        config: configPda,
        market: marketPda,
        ammState: ammStatePda,
        lpMint: lpMintPda,
        lpMintAuthority: lpMintAuthorityPda,
        creatorLpAta: getAssociatedTokenAddressSync(
          lpMintPda,
          ctx.authority.publicKey,
        ),
        lpPosition: lpPositionPda,
        marketVault: deriveMarketVaultAmm(marketId, PROGRAMS),
        creatorAmmAta: getAssociatedTokenAddressSync(
          VENUE_MINT,
          ctx.authority.publicKey,
        ),
        ammMint: VENUE_MINT,
        creator: ctx.authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([heapFrameIx()])
      .transaction()
      .then((tx) => sendAndConfirm(ctx.connection, tx, [ctx.authority]));

    const [lpYieldAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_yield_authority")],
      SOOTH_CORE_ID,
    );
    const [feePoolAuthorityPda] = deriveFeePoolAuthorityPda(PROGRAMS);
    await ctx.program.methods
      .initMarketFeePool()
      .accounts({
        market: marketPda,
        feePoolAuthority: feePoolAuthorityPda,
        bookMint: VENUE_MINT,
        ammMint: VENUE_MINT,
        feePoolBook: feePoolBookPda(marketId, PROGRAMS)[0],
        feePoolAmm: feePoolAmmPda(marketId, PROGRAMS)[0],
        lpYieldAuthority: lpYieldAuthorityPda,
        lpYieldAmm: PublicKey.findProgramAddressSync(
          [Buffer.from("lp_yield_amm"), Buffer.from(marketId)],
          SOOTH_CORE_ID,
        )[0],
        lpYieldBook: PublicKey.findProgramAddressSync(
          [Buffer.from("lp_yield_book"), Buffer.from(marketId)],
          SOOTH_CORE_ID,
        )[0],
        signer: ctx.authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([heapFrameIx()])
      .transaction()
      .then((tx) => sendAndConfirm(ctx.connection, tx, [ctx.authority]));
    log(`${label}: seedLp + initMarketFeePool OK`);
  } catch (err) {
    // Not on the path being proved. Say so loudly and keep going.
    log(
      `${label}: WARNING seed_lp/init_market_fee_pool skipped — ${String(
        err?.message ?? err,
      ).slice(0, 200)}`,
    );
  }
}

// ── Attestation ────────────────────────────────────────────────────────────

/**
 * A Primus-shaped attestation over a value this script actually fetched.
 *
 * `attestorAddr` mirrors the Solidity `Attestor[]` member, which sits OUTSIDE
 * the signed digest — the program cross-checks it against the address it
 * recovers rather than trusting it.
 */
function buildAttestation({ market, value, timestampMs, threshold, privKey }) {
  const att = {
    // Not interpreted on chain, but inside the digest. Binding it to the
    // market makes the payload visibly specific to this run.
    recipient: `0x${hex(market.marketPda.toBytes().slice(0, 20))}`,
    request: {
      url: FEED_URL,
      header: FEED_HEADER,
      method: FEED_METHOD,
      body: "",
    },
    reponseResolve: [
      {
        keyName: FEED_KEY_NAME,
        parseType: FEED_PARSE_TYPE,
        parsePath: FEED_PARSE_PATH,
      },
    ],
    // The single-key object form `zk/value.rs` accepts, keyed by `keyName`.
    data: `{"${FEED_KEY_NAME}":"${value}"}`,
    attConditions: JSON.stringify([
      { op: ">", value: (Number(threshold) / 10 ** VALUE_SCALE).toFixed(6) },
    ]),
    // Milliseconds, the clock Primus mints timestamps with. The program
    // normalizes to unix seconds.
    timestamp: BigInt(timestampMs),
    additionParams: "",
  };
  const signature = signDigest(privKey, encodeAttestation(att));
  return {
    ...att,
    attestors: [
      { attestorAddr: `0x${hex(evmAddress(privKey))}`, url: "https://attestor.local.test" },
    ],
    signatures: [`0x${hex(signature)}`],
  };
}

/** Submits `attest_outcome_zk` through the SDK builder. */
async function submitAttestation(ctx, market, attestation) {
  const req = await ctx.adapter.buildAttestOutcomeZk(
    `sol:${market.marketPda.toBase58()}`,
    {
      user: `sol:${ctx.submitter.publicKey.toBase58()}`,
      attestation: toZkAttestationArg(attestation),
    },
  );
  return sendAndConfirm(
    ctx.connection,
    new Transaction().add(cuLimitIx(), heapFrameIx(), ixFromMeta(req.meta)),
    [ctx.submitter],
  );
}

// ── Main ───────────────────────────────────────────────────────────────────

function loadEnvLocal() {
  if (!existsSync(ENV_LOCAL_PATH)) {
    fail(`${ENV_LOCAL_PATH} not found — the credentials this script reads live there`);
  }
  const out = {};
  for (const line of readFileSync(ENV_LOCAL_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function keypairFrom(bytes, name) {
  if (!bytes) fail(`${name} missing from ${ENV_LOCAL_PATH}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(bytes)));
}

async function main() {
  step("preflight");
  log(`rpc: ${RPC_URL}`);
  log(`program: ${SOOTH_CORE_ID.toBase58()}`);
  selfTestEncoding();

  const env = loadEnvLocal();
  const authority = keypairFrom(env.VITE_TEST_AUTHORITY_BYTES, "VITE_TEST_AUTHORITY_BYTES");
  const submitter = keypairFrom(env.VITE_TEST_KEYPAIR_BYTES, "VITE_TEST_KEYPAIR_BYTES");
  log(`authority/creator: ${authority.publicKey.toBase58()}`);
  log(`submitter:         ${submitter.publicKey.toBase58()}`);

  const connection = new Connection(RPC_URL, "confirmed");
  const version = await connection.getVersion().catch((e) => fail(`cannot reach ${RPC_URL}: ${e.message}`));
  log(`solana-core ${version["solana-core"]}`);

  // `register_zk_adjudicator` is gated the same way the manual path is:
  // permissioned mode means the protocol authority signs, permissionless mode
  // means the market creator does. Checking up front names the problem instead
  // of surfacing it as a bare `Unauthorized`.
  const [configPda] = deriveProtocolConfigPda(PROGRAMS);
  const wallet = {
    publicKey: authority.publicKey,
    signTransaction: async (tx) => (tx.partialSign(authority), tx),
    signAllTransactions: async (txs) => (txs.forEach((t) => t.partialSign(authority)), txs),
    payer: authority,
  };
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(
    { ...soothCoreIdl, address: SOOTH_CORE_ID.toBase58() },
    provider,
  );
  const config = await program.account.protocolConfig.fetch(configPda);
  const permissionless = config.permissionless_adjudicators ?? config.permissionlessAdjudicators;
  const configAuthority = config.authority;
  log(
    `protocol config: permissionless_adjudicators=${permissionless}, authority=${configAuthority.toBase58()}`,
  );
  if (!permissionless && !configAuthority.equals(authority.publicKey)) {
    fail(
      `adjudicator registration is permissioned and this keypair is not the protocol authority`,
    );
  }

  for (const [name, kp] of [["authority", authority], ["submitter", submitter]]) {
    const bal = await connection.getBalance(kp.publicKey);
    log(`${name} balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    if (bal < 0.1 * LAMPORTS_PER_SOL) fail(`${name} is out of SOL`);
  }

  const adapter = new SolanaChainAdapter({
    node: {
      id: "devnet",
      chainKind: "solana",
      chainId: "devnet",
      cluster: "devnet",
      rpcUrl: RPC_URL,
      programs: {
        soothCore: SOOTH_CORE_ID.toBase58(),
        usdcMint: VENUE_MINT.toBase58(),
        ammMint: VENUE_MINT.toBase58(),
      },
    },
    connection,
  });

  const ctx = { connection, program, adapter, authority, submitter };

  // ── The attestor stand-in ───────────────────────────────────────────────
  step("attestor keys");
  const attestorKey = Uint8Array.from(randomBytes(32));
  const impostorKey = Uint8Array.from(randomBytes(32));
  const attestorEvm = `0x${hex(evmAddress(attestorKey))}`;
  const impostorEvm = `0x${hex(evmAddress(impostorKey))}`;
  log(`registered attestor: ${attestorEvm}`);
  log(`impostor (never registered): ${impostorEvm}`);

  // ── The rule ────────────────────────────────────────────────────────────
  step("endpoint and rule");
  const preview = await fetchFeed();
  log(`${FEED_URL} -> ${FEED_PARSE_PATH} = ${preview.raw}`);
  // Threshold sits a fixed margin below spot so the GT predicate has a stable
  // answer across the ~30s between this reading and the attested one.
  const threshold = preview.scaled - THRESHOLD_MARGIN_USD * 10n ** BigInt(VALUE_SCALE);
  if (threshold <= 0n) fail(`feed value ${preview.raw} is below the chosen margin`);
  const ruleHash = await computeRuleHash(FEED_URL, FEED_PARSE_PATH);
  log(`rule: value GT ${(Number(threshold) / 10 ** VALUE_SCALE).toFixed(6)} at scale ${VALUE_SCALE}`);
  log(`rule_hash: 0x${hex(ruleHash)}`);
  const rule = { attestorEvm, ruleHash, threshold };

  // ── Markets ─────────────────────────────────────────────────────────────
  step("creating two fresh markets");
  const marketA = await createZkMarket(ctx, "market-A (positive)", rule);
  const marketB = await createZkMarket(ctx, "market-B (negative)", rule);

  // ── Lock ────────────────────────────────────────────────────────────────
  step("locking both markets");
  for (const m of [marketA, marketB]) {
    const waitMs = (m.deadline + 2) * 1000 - Date.now();
    if (waitMs > 0) {
      log(`waiting ${Math.ceil(waitMs / 1000)}s for ${m.label}'s deadline`);
      await sleep(waitMs);
    }
    const lockTx = await program.methods
      .requestLock()
      .accounts({
        adjudicatorEntry: m.adjudicatorPda,
        market: m.marketPda,
        authority: authority.publicKey,
      })
      .preInstructions([heapFrameIx()])
      .transaction();
    const sig = await sendAndConfirm(connection, lockTx, [authority]);
    m.lockSig = sig;
    log(`${m.label}: requestLock ${sig}`);
  }

  // ── The observation ─────────────────────────────────────────────────────
  step("fetching the attested reading");
  const observed = await fetchFeed();
  const observedAtMs = Date.now();
  log(`observed ${FEED_PARSE_PATH} = ${observed.raw} at ${new Date(observedAtMs).toISOString()}`);
  const expectedOutcome = observed.scaled > threshold ? 1 : 0;

  // ── POSITIVE ────────────────────────────────────────────────────────────
  step("POSITIVE: genuine attestation on market-A");
  const genuine = buildAttestation({
    market: marketA,
    value: observed.raw,
    timestampMs: observedAtMs,
    threshold,
    privKey: attestorKey,
  });
  log(`data: ${genuine.data}`);
  log(`signature: ${genuine.signatures[0]}`);
  let attestSig = null;
  try {
    attestSig = await submitAttestation(ctx, marketA, genuine);
    record("attest_outcome_zk accepts a correctly signed attestation", true, attestSig);
  } catch (err) {
    const code = anchorErrorCode(err);
    record(
      "attest_outcome_zk accepts a correctly signed attestation",
      false,
      `rejected with ${code} (${ZK_ERRORS[code] ?? "unknown"}) — ${JSON.stringify(err.txErr ?? err.message)}`,
    );
  }

  // ── Read back ───────────────────────────────────────────────────────────
  step("reading the AdjudicatorEntry back from chain");
  const entry = await program.account.adjudicatorEntry.fetch(marketA.adjudicatorPda);
  const attestedOutcome = entry.attested_outcome ?? entry.attestedOutcome;
  const attestedAt = entry.attested_at ?? entry.attestedAt;
  const onChainThreshold = BigInt((entry.zk_threshold ?? entry.zkThreshold).toString());
  const onChainComparator = entry.zk_comparator ?? entry.zkComparator;
  const onChainScale = entry.zk_value_scale ?? entry.zkValueScale;
  const onChainAttestor = `0x${hex(Uint8Array.from(entry.zk_attestor_evm ?? entry.zkAttestorEvm))}`;
  const comparatorName = Object.entries(ZK_COMPARATOR).find(([, v]) => v === onChainComparator)?.[0];
  const outcomeName = attestedOutcome === 1 ? "YES" : attestedOutcome === 0 ? "NO" : "none";

  log(`market:             ${marketA.marketPda.toBase58()}`);
  log(`adjudicator entry:  ${marketA.adjudicatorPda.toBase58()}`);
  log(`registered attestor:${onChainAttestor}`);
  log(`comparator:         ${comparatorName} (${onChainComparator})`);
  log(`value scale:        ${onChainScale}`);
  log(`threshold:          ${(Number(onChainThreshold) / 10 ** onChainScale).toFixed(6)} (raw ${onChainThreshold})`);
  log(`real value fetched: ${observed.raw} (raw ${observed.scaled})`);
  log(`attested outcome:   ${outcomeName} (${attestedOutcome})`);
  log(
    `attested_at:        ${attestedAt ? `${attestedAt.toString()} (${new Date(Number(attestedAt) * 1000).toISOString()})` : "null"}`,
  );
  log(
    `follows from data:  ${observed.raw} ${comparatorName === "Gt" ? ">" : comparatorName} ` +
      `${(Number(onChainThreshold) / 10 ** onChainScale).toFixed(6)} = ${observed.scaled > onChainThreshold} -> ${outcomeName}`,
  );

  record(
    "the recorded outcome follows from the fetched value and the registered rule",
    attestedOutcome === expectedOutcome && attestedAt != null,
    `expected ${expectedOutcome === 1 ? "YES" : "NO"}, got ${outcomeName}`,
  );
  record(
    "the on-chain rule is the one that was registered",
    onChainAttestor.toLowerCase() === attestorEvm.toLowerCase() &&
      onChainThreshold === threshold &&
      onChainComparator === ZK_COMPARATOR.Gt,
    `attestor=${onChainAttestor}`,
  );

  // ── NEGATIVE 1: wrong signer ────────────────────────────────────────────
  step("NEGATIVE 1: attestation signed by an unregistered key, on market-B");
  const forged = buildAttestation({
    market: marketB,
    value: observed.raw,
    timestampMs: observedAtMs,
    threshold,
    privKey: impostorKey,
  });
  log(`same data, signed by ${impostorEvm} instead of ${attestorEvm}`);
  await expectRejection(
    ctx,
    marketB,
    forged,
    "attest_outcome_zk rejects an attestation from an unregistered attestor",
    [6077 /* ZkAttestorMismatch */],
  );

  // ── NEGATIVE 2: tampered value ──────────────────────────────────────────
  step("NEGATIVE 2: value edited after signing, on market-B");
  const tampered = buildAttestation({
    market: marketB,
    value: observed.raw,
    timestampMs: observedAtMs,
    threshold,
    privKey: attestorKey,
  });
  const originalData = tampered.data;
  // The signature stays untouched; only the value the program will act on
  // changes. Re-encoding on chain is what makes this fail — accepting a
  // caller-supplied digest would not.
  tampered.data = `{"${FEED_KEY_NAME}":"${(Number(observed.raw) * 2).toFixed(3)}"}`;
  log(`signed over ${originalData}, submitting ${tampered.data}`);
  await expectRejection(
    ctx,
    marketB,
    tampered,
    "attest_outcome_zk rejects an attestation whose value was edited after signing",
    [6076 /* ZkSignatureRecoveryFailed */, 6077 /* ZkAttestorMismatch */],
  );

  // market-B must still be unattested — a rejected attestation writes nothing.
  const entryB = await program.account.adjudicatorEntry.fetch(marketB.adjudicatorPda);
  const outcomeB = entryB.attested_outcome ?? entryB.attestedOutcome;
  record(
    "market-B is left unattested after both rejections",
    outcomeB === null || outcomeB === undefined,
    `attested_outcome=${outcomeB}`,
  );

  // ── Summary ─────────────────────────────────────────────────────────────
  step("SUMMARY");
  log(`market-A (attested): ${marketA.marketPda.toBase58()}`);
  log(`market-B (rejected): ${marketB.marketPda.toBase58()}`);
  log("transaction signatures:");
  for (const m of [marketA, marketB]) {
    log(`  ${m.label} createMarket           ${m.createSig}`);
    log(`  ${m.label} registerZkAdjudicator  ${m.registerSig}`);
    log(`  ${m.label} requestLock            ${m.lockSig}`);
  }
  if (attestSig) log(`  market-A attestOutcomeZk         ${attestSig}`);
  process.stdout.write("\n");
  for (const r of results) {
    process.stdout.write(
      `  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `\n          ${r.detail}` : ""}\n`,
    );
  }
  const failed = results.filter((r) => !r.passed).length;
  process.stdout.write(
    `\n[zk-attest] ${failed === 0 ? "ALL PASS" : `${failed} FAILED`} (${results.length} checks)\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

/** Submits an attestation that MUST be rejected, and records the rejection. */
async function expectRejection(ctx, market, attestation, name, acceptableCodes) {
  try {
    const sig = await submitAttestation(ctx, market, attestation);
    record(name, false, `program ACCEPTED it — ${sig}`);
  } catch (err) {
    const code = anchorErrorCode(err);
    const label = `${code} (${ZK_ERRORS[code] ?? "unrecognised"})`;
    record(name, acceptableCodes.includes(code), `rejected with ${label}`);
  }
}

main().catch((err) => {
  process.stderr.write(`[zk-attest] UNCAUGHT: ${err?.stack ?? err}\n`);
  if (err?.logs) process.stderr.write(err.logs.join("\n") + "\n");
  process.exit(1);
});
