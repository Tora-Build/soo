#!/usr/bin/env node
// Seed script for the localnet demo. Two-phase, both phases run as plain
// Node ESM (no tsx/ts-node) so we depend only on `@sooth/sdk-solana/dist`
// which is already built before this script runs.
//
// Phase 1 — `prepare`:
//   - Generate a USDC mint authority keypair (.localnet/mint-authority.json)
//   - Hand-build the SPL Mint account blob and write it as a
//     solana-test-validator-compatible JSON dump
//     (.localnet/usdc-mint-account.json)
//   - This phase must run BEFORE the validator boots, so the validator can
//     `--account 4zMM... .localnet/usdc-mint-account.json` preload the mint
//     at the canonical address that the on-chain programs constrain against.
//
// Phase 2 — `init`:
//   - Connect to http://127.0.0.1:8899
//   - Generate creator + user keypairs (or read user pubkey from CLI/env)
//   - Airdrop SOL to creator + user
//   - Create the user's USDC ATA + mint 1000 USDC into it (mint authority
//     keypair from phase 1 signs)
//   - Bootstrap the adjudicator allowlist PDA + register the creator as the
//     demo adjudicator (Codex C2 minimum-viable mitigation; sooth_market now
//     rejects `initialize_market` if the named adjudicator is the default key
//     OR is absent from the on-chain allowlist). On localnet we use the
//     creator wallet as both the allowlist authority AND the adjudicator —
//     in production these are separate roles (multisig vs adjudicator
//     program) but the demo collapses them for convenience.
//   - Run all 4 init instructions to create a Sooth market
//     (initializeMarket → initializeOutcomeMints → initializeMarketVaults →
//     initializeAmmState)
//   - Write apps/demo/.env.local with VITE_DEMO_MARKET_REF + companion vars
//   - Print the user keypair so the operator can import into Phantom
//
// Wire shape mirrors apps/demo/tests/fixtures/bootDemo.ts (bankrun) but
// against a real Connection. Differences from bankrun:
//   - We can't setAccount() the USDC mint into existence at runtime; we
//     pre-bake the JSON dump and let solana-test-validator load it.
//   - Lamport funding is via requestAirdrop + confirmTransaction, not a
//     direct write.
//   - Anchor's AnchorProvider talks to the real Connection so all RPC calls
//     are network round-trips.
//
// No emojis in script output (project rule).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Anchor + sdk-solana ship as CommonJS or have a deep CJS dep
// (`@coral-xyz/anchor`). Node's ESM loader rejects named imports from those
// modules — unlike vitest/esbuild which transparently rewrites them. Use
// the default-import + destructure dance for any package that surfaces the
// CJS named-export error at runtime.
import anchor from "@coral-xyz/anchor";
const { AnchorProvider, BN, Program } = anchor;

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MintLayout,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
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
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// We can't `import` from the `@sooth/sdk-solana` package root: its index
// re-exports `SolanaChainAdapter`, which transitively imports
// `@coral-xyz/anchor` with named exports. Anchor 0.30 is CommonJS, and
// Node's ESM loader rejects `import { BN } from "@coral-xyz/anchor"` at
// parse time. Vitest/esbuild rewrite this transparently, but plain
// `node` doesn't.
//
// We can't deep-import from `@sooth/sdk-solana/dist/...` either — the
// package's `exports` map restricts subpaths.
//
// Workaround: dynamic-import the leaf dist modules via filesystem URLs.
// This bypasses both the package `exports` gate AND the adapter.js side
// effect. A future SDK build that renames internal dist paths would
// break this script. The alternative — adding subpath exports to the
// SDK — is out of scope per the task brief.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEMO_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(DEMO_ROOT, "..", "..");
const LOCALNET_DIR = resolve(DEMO_ROOT, ".localnet");

const SDK_DIST = resolve(REPO_ROOT, "packages", "sdk-solana", "dist");
const sdkUrl = (rel) => new URL(`file://${SDK_DIST}/${rel}`).href;

const {
  soothAdjudicatorIdl,
  soothAmmIdl,
  soothBookIdl,
  soothLaunchpadIdl,
  soothMarketIdl,
} = await import(sdkUrl("anchor/index.js"));
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
  SOOTH_BOOK_PROGRAM_ID,
  SOOTH_LAUNCHPAD_PROGRAM_ID,
  SOOTH_MARKET_PROGRAM_ID,
} = await import(sdkUrl("pdas.js"));
const { WAD } = await import(sdkUrl("math/lmsr.js"));

function programIdOrFallback(idlAddress, fallback) {
  return idlAddress ? new PublicKey(idlAddress) : fallback;
}

const SOOTH_AMM_ID = new PublicKey(soothAmmIdl.address);
const SOOTH_MARKET_ID = programIdOrFallback(
  soothMarketIdl.address,
  SOOTH_MARKET_PROGRAM_ID,
);
const SOOTH_LAUNCHPAD_ID = programIdOrFallback(
  soothLaunchpadIdl.address,
  SOOTH_LAUNCHPAD_PROGRAM_ID,
);
const SOOTH_ADJUDICATOR_ID = new PublicKey(soothAdjudicatorIdl.address);
const SOOTH_BOOK_ID = programIdOrFallback(
  soothBookIdl.address,
  SOOTH_BOOK_PROGRAM_ID,
);
const soothMarketProgramIdl = {
  ...soothMarketIdl,
  address: SOOTH_MARKET_ID.toBase58(),
};
const soothLaunchpadProgramIdl = {
  ...soothLaunchpadIdl,
  address: SOOTH_LAUNCHPAD_ID.toBase58(),
};
const soothBookProgramIdl = {
  ...soothBookIdl,
  address: SOOTH_BOOK_ID.toBase58(),
};
const PROGRAMS = {
  soothAmm: SOOTH_AMM_ID,
  soothMarket: SOOTH_MARKET_ID,
  soothLaunchpad: SOOTH_LAUNCHPAD_ID,
  soothAdjudicator: SOOTH_ADJUDICATOR_ID,
  soothBook: SOOTH_BOOK_ID,
};

// Canonical USDC mint baked into the on-chain programs' `address = ...`
// constraint. The mint MUST exist at this address on the validator or
// initialize_market_vaults / trade_positions will fail.
const USDC_MINT_DEVNET = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

const MINT_AUTHORITY_PATH = resolve(LOCALNET_DIR, "mint-authority.json");
const USER_KEYPAIR_PATH = resolve(LOCALNET_DIR, "user-keypair.json");
const CREATOR_KEYPAIR_PATH = resolve(LOCALNET_DIR, "creator-keypair.json");
const USDC_MINT_DUMP_PATH = resolve(LOCALNET_DIR, "usdc-mint-account.json");
const LOCALNET_ENV_PATH = resolve(LOCALNET_DIR, ".env.local");
const ENV_LOCAL_PATH = resolve(DEMO_ROOT, ".env.local");

const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const BOOK_PRICE_LADDER_SEED = "sooth-default";
// SBF heap is 32KB total and Anchor's account-loading framework eats a
// chunk of it. Empirically, AddPricesToPriceLadder fails with OOM at
// 600 prices (account ~9.6KB). 100 prices = 1.6KB account fits cleanly.
// Smaller ladder = coarser tick spacing; spec uses 0.4·WAD which still
// hits the 0.001-WAD-spaced default ladder cleanly (price = tick 400 in
// a 1000-cap world; with 100 prices we instead use 0.01·WAD spacing).
// See seed-localnet's bookDefaultPriceStrings for the actual tick values.
const BOOK_PRICE_LADDER_MAX_PRICES = 100;
const BOOK_MARKET_TYPE_NAME = "sooth-binary";
// Must be <= BOOK_PRICE_LADDER_MAX_PRICES; capped here to fit the
// PriceLadder account's 10KB SystemProgram::create_account limit.
const BOOK_DEFAULT_PRICE_COUNT = BOOK_PRICE_LADDER_MAX_PRICES;
const BOOK_PRICE_TICK_WAD = 1_000_000_000_000_000n;
// Smaller chunk size to fit Solana's 32KB SBF heap. add_prices_to_price_ladder
// deserializes the existing Vec<u128>, decodes new prices, merges, and
// re-serializes — heap usage scales with (existing + new) entries. 10 per
// chunk keeps each tx well under the heap cap even when the ladder is near
// full. 60 chunks × 10 prices = 600 ladder entries.
const BOOK_PRICE_ADD_CHUNK_SIZE = 10;

function log(msg) {
  process.stdout.write(`[seed-localnet] ${msg}\n`);
}

function die(msg, code = 1) {
  process.stderr.write(`[seed-localnet] ERROR: ${msg}\n`);
  process.exit(code);
}

function ensureLocalnetDir() {
  mkdirSync(LOCALNET_DIR, { recursive: true });
}

function bookDefaultPriceStrings() {
  // 100-tick ladder at stride 5 ticks (0.005·WAD spacing). Range covered:
  // 0.005·WAD to 0.500·WAD. Includes the spec's reference price 0.4·WAD
  // (= 80*stride = 400·PRICE_TICK), and every tick is a valid multiple
  // of PRICE_TICK so price_precision_is_within_range passes. Sized so the
  // PriceLadder account stays under the SBF heap budget for AddPrices'
  // deserialize+modify+serialize roundtrip.
  const STRIDE_TICKS = 5n;
  const stride = STRIDE_TICKS * BOOK_PRICE_TICK_WAD;
  return Array.from({ length: BOOK_DEFAULT_PRICE_COUNT }, (_, index) =>
    (BigInt(index + 1) * stride).toString(),
  );
}

function bookDefaultPrices() {
  return bookDefaultPriceStrings().map((price) => new BN(price));
}

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function deriveBookPriceLadderPda(authority, distinctSeed) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("price_ladder"),
      authority.toBuffer(),
      Buffer.from(distinctSeed),
    ],
    SOOTH_BOOK_ID,
  )[0];
}

function deriveBookMarketTypePda(name) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market_type"), Buffer.from(name)],
    SOOTH_BOOK_ID,
  )[0];
}

function deriveBookAuthorisedOperatorsPda(operatorType) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("authorised_operators"), Buffer.from(operatorType)],
    SOOTH_BOOK_ID,
  )[0];
}

function operatorListContains(account, operator) {
  return (
    Array.isArray(account?.operatorList) &&
    account.operatorList.some((item) => item.equals(operator))
  );
}

function bookSingletonEnvLines(singletons) {
  return [
    `VITE_SOOTH_BOOK_ID=${SOOTH_BOOK_ID.toBase58()}`,
    `VITE_SOOTH_BOOK_PRICE_LADDER_PDA=${singletons.priceLadderPda.toBase58()}`,
    `VITE_SOOTH_BOOK_PRICE_LADDER_SEED=${BOOK_PRICE_LADDER_SEED}`,
    `VITE_SOOTH_BOOK_MARKET_TYPE_PDA=${singletons.marketTypePda.toBase58()}`,
    `VITE_SOOTH_BOOK_MARKET_TYPE_NAME=${BOOK_MARKET_TYPE_NAME}`,
    `VITE_SOOTH_BOOK_ADMIN_OPERATORS_PDA=${singletons.adminOperatorsPda.toBase58()}`,
    `VITE_SOOTH_BOOK_MARKET_OPERATORS_PDA=${singletons.marketOperatorsPda.toBase58()}`,
    `VITE_SOOTH_BOOK_SEED_AUTHORITY=${singletons.seedAuthority.toBase58()}`,
  ];
}

function writeBookLocalnetEnv(singletons) {
  const envBody = [
    "# Auto-generated by apps/demo/scripts/seed-localnet.mjs.",
    "# SoothBook protocol singleton addresses for local e2e helpers.",
    "# Regenerated every time `pnpm dev:surfpool` runs.",
    "",
    ...bookSingletonEnvLines(singletons),
    "",
  ].join("\n");
  writeFileSync(LOCALNET_ENV_PATH, envBody);
  log(`wrote ${LOCALNET_ENV_PATH}`);
}

function loadOrCreateKeypair(path) {
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

// ─── Phase 1 ──────────────────────────────────────────────────────────────
async function prepare() {
  ensureLocalnetDir();
  const mintAuthority = loadOrCreateKeypair(MINT_AUTHORITY_PATH);
  log(`mint authority pubkey: ${mintAuthority.publicKey.toBase58()}`);

  // Build the SPL Mint binary blob. Layout matches `@solana/spl-token`'s
  // MintLayout exactly (4+32+8+1+1+4+32 = 82 bytes).
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority: mintAuthority.publicKey,
      supply: 0n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );

  // Rent-exempt minimum for 82-byte account. The validator computes its
  // own rent, but we still set lamports >= the empirically-known minimum
  // (~1.46M lamports for 82 bytes at default rates). 10 SOL is overkill
  // and works in every case.
  const lamports = 10 * LAMPORTS_PER_SOL;

  const dump = {
    pubkey: USDC_MINT_DEVNET.toBase58(),
    account: {
      lamports,
      data: [data.toString("base64"), "base64"],
      owner: TOKEN_PROGRAM_ID.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: MINT_SIZE,
    },
  };
  writeFileSync(USDC_MINT_DUMP_PATH, JSON.stringify(dump, null, 2));
  log(`wrote usdc mint dump: ${USDC_MINT_DUMP_PATH}`);
  log(`  pubkey: ${USDC_MINT_DEVNET.toBase58()}`);
  log(`  authority: ${mintAuthority.publicKey.toBase58()}`);
  log(`  decimals: 6`);
}

// ─── Phase 2 ──────────────────────────────────────────────────────────────
async function init() {
  ensureLocalnetDir();

  if (!existsSync(MINT_AUTHORITY_PATH)) {
    die("mint authority keypair missing — run `prepare` phase first");
  }
  const mintAuthority = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(MINT_AUTHORITY_PATH, "utf8"))),
  );
  const creator = loadOrCreateKeypair(CREATOR_KEYPAIR_PATH);
  const user = loadOrCreateKeypair(USER_KEYPAIR_PATH);

  log(`creator: ${creator.publicKey.toBase58()}`);
  log(`user:    ${user.publicKey.toBase58()}`);

  const connection = new Connection(RPC_URL, "confirmed");

  // Sanity-check: validator running + USDC mint preloaded.
  try {
    await connection.getVersion();
  } catch (e) {
    die(`cannot reach validator at ${RPC_URL}: ${e.message ?? e}`);
  }

  const usdcMintAcc = await connection.getAccountInfo(USDC_MINT_DEVNET);
  if (!usdcMintAcc) {
    die(
      `USDC mint not present at ${USDC_MINT_DEVNET.toBase58()} — did you boot the validator with --account?`,
    );
  }
  if (!usdcMintAcc.owner.equals(TOKEN_PROGRAM_ID)) {
    die(
      `USDC mint at ${USDC_MINT_DEVNET.toBase58()} is owned by ${usdcMintAcc.owner.toBase58()}, expected SPL Token program`,
    );
  }
  log(`USDC mint preloaded: OK`);

  // ─── Airdrop SOL to creator + user + mintAuthority ─────────────────────
  for (const [name, kp] of [
    ["creator", creator],
    ["user", user],
    ["mintAuthority", mintAuthority],
  ]) {
    const balance = await connection.getBalance(kp.publicKey);
    if (balance >= 5 * LAMPORTS_PER_SOL) {
      log(
        `${name} already funded (${balance / LAMPORTS_PER_SOL} SOL), skip airdrop`,
      );
      continue;
    }
    const sig = await connection.requestAirdrop(
      kp.publicKey,
      10 * LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(sig, "confirmed");
    log(`airdropped 10 SOL to ${name}`);
  }

  // ─── Mint 1000 USDC to the user ───────────────────────────────────────
  const userAta = getAssociatedTokenAddressSync(
    USDC_MINT_DEVNET,
    user.publicKey,
  );
  const ataInfo = await connection.getAccountInfo(userAta);
  if (!ataInfo) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        userAta,
        user.publicKey,
        USDC_MINT_DEVNET,
      ),
    );
    await sendAndConfirmTransaction(connection, tx, [creator]);
    log(`created user USDC ATA: ${userAta.toBase58()}`);
  } else {
    log(`user USDC ATA exists: ${userAta.toBase58()}`);
  }

  const userUsdc = 1_000_000_000n; // 1000 USDC (6 decimals)
  const mintTx = new Transaction().add(
    createMintToInstruction(
      USDC_MINT_DEVNET,
      userAta,
      mintAuthority.publicKey,
      userUsdc,
    ),
  );
  await sendAndConfirmTransaction(connection, mintTx, [mintAuthority]);
  log(`minted 1000 USDC to user`);

  const creatorTreasuryAta = getAssociatedTokenAddressSync(
    USDC_MINT_DEVNET,
    creator.publicKey,
  );
  const treasuryAtaTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      creator.publicKey,
      creatorTreasuryAta,
      creator.publicKey,
      USDC_MINT_DEVNET,
    ),
  );
  await sendAndConfirmTransaction(connection, treasuryAtaTx, [creator]);
  log(`creator treasury USDC ATA: ${creatorTreasuryAta.toBase58()}`);

  // ─── Build Anchor providers + create market ───────────────────────────
  const wallet = {
    publicKey: creator.publicKey,
    signTransaction: async (tx) => {
      tx.partialSign(creator);
      return tx;
    },
    signAllTransactions: async (txs) => {
      for (const tx of txs) tx.partialSign(creator);
      return txs;
    },
    payer: creator,
  };
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  const marketProgram = new Program(soothMarketProgramIdl, provider);
  const launchpadProgram = new Program(soothLaunchpadProgramIdl, provider);
  const adjudicatorProgram = new Program(soothAdjudicatorIdl, provider);
  const bookProgram = new Program(soothBookProgramIdl, provider);

  // 16-byte random market id.
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
  const [configPda] = deriveProtocolConfigPda({
    soothLaunchpad: SOOTH_LAUNCHPAD_ID,
  });

  // Use chain time, not 1_000_000 sentinel (real validator wall clock).
  const startTime = Math.floor(Date.now() / 1000);
  const deadline = startTime + 7 * 24 * 60 * 60;
  const bWad = 1_000n * WAD;

  // ─── ProtocolConfig (singleton) ──────────────────────────────────────
  //
  // `create_market` reads `default_trial_period` from this PDA — initialise
  // it once per cluster deploy. Idempotent: if the PDA already exists
  // (re-runs of the seed), skip the bootstrap.
  const configInfo = await connection.getAccountInfo(configPda);
  if (!configInfo) {
    await launchpadProgram.methods
      .initializeProtocol({
        feeBps: 100, // 1%
        treasury: creatorTreasuryAta,
        bBaseShareBps: 5_000,
        lpYieldShareBps: 3_000,
        adjudicatorShareBps: 1_000,
        protocolShareBps: 1_000,
        defaultTrialPeriod: new BN(7 * 24 * 60 * 60),
      })
      .accounts({
        config: configPda,
        authority: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();
    log(`  initializeProtocol OK (authority=${creator.publicKey.toBase58()})`);
  } else {
    log(
      `  ProtocolConfig PDA already present at ${configPda.toBase58()}, skipping bootstrap`,
    );
  }

  // ─── Global fee_pool_vault (Wave 5A) ──────────────────────────────────
  //
  // `sooth_amm::trade_positions` and `sell_positions` both push the
  // per-trade fee USDC slice into a singleton ATA owned by the
  // `fee_pool_authority` PDA. The ATA must exist before any buy/sell
  // lands. Idempotent: skip if already present.
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
        signer: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([creator])
      .rpc();
    log(`  initializeFeePool OK (vault=${feePoolVault.toBase58()})`);
  } else {
    log(
      `  fee_pool_vault already present at ${feePoolVault.toBase58()}, skipping bootstrap`,
    );
  }

  // The current W7 SoothBook program has no Monaco-era price ladder,
  // market-type, or operator singleton bootstrap. MarketBook and BookSide
  // PDAs are created lazily by buy_yes/buy_no.
  const bookSingletons = null;
  log("  SoothBook singleton bootstrap skipped (direct BookSide ABI)");

  // ─── Global lp_yield_vault (redeem_lp payout source) ─────────────────
  //
  // `sooth_launchpad::redeem_lp` pays pro-rata USDC from a singleton ATA
  // owned by the `lp_yield_authority` PDA. The idempotent ATA create keeps
  // localnet re-seeds safe and gives the demo a stable env pointer.
  const [lpYieldAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_yield_authority")],
    SOOTH_LAUNCHPAD_ID,
  );
  const lpYieldVaultAta = getAssociatedTokenAddressSync(
    USDC_MINT_DEVNET,
    lpYieldAuthorityPda,
    true,
  );
  const lpYieldTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      creator.publicKey,
      lpYieldVaultAta,
      lpYieldAuthorityPda,
      USDC_MINT_DEVNET,
    ),
  );
  await sendAndConfirmTransaction(connection, lpYieldTx, [creator]);
  log(`  lp_yield_authority=${lpYieldAuthorityPda.toBase58()}`);
  log(`  lp_yield_vault=${lpYieldVaultAta.toBase58()}`);

  // ─── Adjudicator allowlist (Codex C2 minimum-viable mitigation) ──────
  //
  // On-chain `initialize_market` (now reached via the `create_market` CPI
  // chain) still requires:
  //   1. `args.adjudicator != Pubkey::default()`
  //   2. The pubkey to be present on the singleton AdjudicatorAllowlist PDA.
  //
  // The allowlist is initialised once per program deployment. On localnet
  // the creator wallet doubles as the allowlist authority AND the
  // adjudicator pubkey for the demo market. In production these would be
  // distinct (multisig governance + actual adjudicator program signer);
  // the localnet collapse is purely for convenience. Re-running the seed
  // is idempotent: we look up the PDA first and skip the bootstrap if it
  // already exists.
  const [allowlistPda] = deriveAdjudicatorAllowlistPda(PROGRAMS);
  const allowlistInfo = await connection.getAccountInfo(allowlistPda);
  if (!allowlistInfo) {
    await marketProgram.methods
      .initializeAdjudicatorAllowlist(creator.publicKey)
      .accounts({
        allowlist: allowlistPda,
        signer: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();
    log(
      `  initializeAdjudicatorAllowlist OK (authority=${creator.publicKey.toBase58()})`,
    );
  } else {
    log(
      `  allowlist PDA already present at ${allowlistPda.toBase58()}, skipping bootstrap`,
    );
  }

  // Register the demo adjudicator. We attempt-and-tolerate-already-listed
  // because the PDA may have been initialised by a previous run while the
  // creator keypair on disk has since been regenerated (rare but possible
  // when the operator wipes only part of .localnet/). The on-chain
  // AdjudicatorAlreadyAllowlisted error is thrown in that case.
  const demoAdjudicator = creator.publicKey;
  try {
    await marketProgram.methods
      .addAdjudicator(demoAdjudicator)
      .accounts({
        allowlist: allowlistPda,
        authority: creator.publicKey,
      })
      .signers([creator])
      .rpc();
    log(`  addAdjudicator OK (adjudicator=${demoAdjudicator.toBase58()})`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (msg.includes("AdjudicatorAlreadyAllowlisted")) {
      log(
        `  adjudicator ${demoAdjudicator.toBase58()} already allow-listed, skipping`,
      );
    } else {
      throw e;
    }
  }

  log(`creating market PDA ${marketPda.toBase58()}...`);

  // ─── create_market (one-shot) ────────────────────────────────────────
  //
  // Composes the four-leg init flow (initialize_market +
  // initialize_outcome_mints + initialize_market_vaults +
  // initialize_amm_state) into a single CPI from `sooth_launchpad`. See
  // `programs/sooth_launchpad/src/instructions/create_market.rs` and
  // architecture §4.1. The legacy 4-tx flow can be reconstructed from
  // git history if a future on-chain change forces splitting again.
  // The createMarket flow CPIs into 4 inner ixs (initialize_market +
  // initialize_outcome_mints + initialize_market_vaults +
  // initialize_amm_state). Solana's default 200k CU budget is too tight
  // — observed exhaustion mid-InitializeAmmState. Bump to the per-ix
  // ceiling (1.4M) via a pre-ix.
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
      creator: creator.publicKey,
      soothMarketProgram: SOOTH_MARKET_ID,
      soothAmmProgram: SOOTH_AMM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ])
    .signers([creator])
    .rpc();
  log("  createMarket OK (one-shot — composed 4 inner CPIs)");

  // ─── Register the per-market Adjudicator PDA ─────────────────────────
  //
  // Wave 5 adjudicator framework (closes the deferred half of Codex's C2
  // finding). After market creation we register an `Adjudicator` PDA on
  // `sooth_adjudicator` that records the per-market authority + variant.
  // The CPI introspection on `sooth_market::lock_for_resolution` and
  // `sooth_market::settle` requires this program to be the calling top-
  // level ix, so the demo flow now needs the PDA to exist before any
  // resolution attempt.
  //
  // The `AdjudicatorAllowlist` (above) remains in place as defense-in-
  // depth — it constrains the SET of pubkeys that can be named as
  // `Market.adjudicator` at create-time.
  //
  // For the demo: creator is both allowlist authority AND per-market
  // adjudicator authority. Production splits these roles across multisig
  // governance + an actual signing key.
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
        signer: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();
    log(
      `  registerAdjudicator OK (kind=Manual, authority=${demoAdjudicator.toBase58()})`,
    );
  } else {
    log(
      `  Adjudicator PDA already present at ${adjudicatorPda.toBase58()}, skipping`,
    );
  }

  // ─── seed_lp (gap-fill: surfaced by the Wave 9 Playwright e2e) ──────
  //
  // sooth_amm::trade_positions requires the per-market lp_mint PDA to
  // exist before its LP-ATA-create pre-instruction can succeed. Without
  // this, the first buy fails with IncorrectProgramId. Wave 9's e2e
  // discovered the gap; the user-facing dev:localnet flow must seed_lp
  // here so a fresh `pnpm dev:localnet` lands a buy-ready market.
  //
  // Idempotent: skip if lp_mint already exists.
  const [lpMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), Buffer.from(marketId)],
    SOOTH_LAUNCHPAD_ID,
  );
  const [lpMintAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint_authority"), Buffer.from(marketId)],
    SOOTH_LAUNCHPAD_ID,
  );
  const [lpPositionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("lp_position"),
      Buffer.from(marketId),
      creator.publicKey.toBuffer(),
    ],
    SOOTH_LAUNCHPAD_ID,
  );
  const creatorLpAta = getAssociatedTokenAddressSync(
    lpMintPda,
    creator.publicKey,
  );
  const lpMintInfo = await connection.getAccountInfo(lpMintPda);
  if (!lpMintInfo) {
    // Mirrors bootSmoke (packages/sdk-solana/tests/fixtures/setup.ts):
    // lp_amount = bWad / 1e12 (USDC base units, 6 decimals).
    const lpAmountBaseUnits = bWad / 1_000_000_000_000n;
    await launchpadProgram.methods
      .seedLp({
        lpAmount: new BN(lpAmountBaseUnits.toString()),
        seedDepositWad: new BN(bWad.toString()),
      })
      .accounts({
        config: configPda,
        market: marketPda,
        ammState: ammStatePda,
        lpMint: lpMintPda,
        lpMintAuthority: lpMintAuthorityPda,
        creatorLpAta,
        lpPosition: lpPositionPda,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([creator])
      .rpc();
    log(
      `  seedLp OK (lp_mint=${lpMintPda.toBase58()}, lp_amount=${lpAmountBaseUnits} base units)`,
    );
  } else {
    log(`  lp_mint ${lpMintPda.toBase58()} already exists, skipping seedLp`);
  }

  // ─── Write .env.local for vite ────────────────────────────────────────
  // Inline the mint authority secret bytes so the in-browser faucet
  // (apps/demo/src/pages/Faucet.tsx → amm-bridge `mint` dispatch) can sign
  // the SPL `MintTo` ix. Localnet ONLY — production replaces this with a
  // backend mint endpoint or removes the faucet outright.
  const mintAuthorityBytes = JSON.stringify(
    Array.from(mintAuthority.secretKey),
  );
  const allowlistAuthorityBytes = JSON.stringify(Array.from(creator.secretKey));
  const envBody = [
    "# Auto-generated by apps/demo/scripts/seed-localnet.mjs.",
    "# Regenerated every time `pnpm dev:localnet` runs.",
    "# Do not commit — see apps/demo/.gitignore.",
    "",
    `VITE_SOLANA_RPC_URL=${RPC_URL}`,
    `# No EVM indexer on the Solana fork — short-circuits the poller`,
    `# at apps/demo/src/hooks/indexer/config.ts to silence the dead-URL`,
    `# error storm (was ~261k console errors per page session).`,
    `VITE_USE_INDEXER=false`,
    `VITE_SOOTH_AMM_ID=${SOOTH_AMM_ID.toBase58()}`,
    `VITE_SOOTH_MARKET_ID=${SOOTH_MARKET_ID.toBase58()}`,
    `VITE_SOOTH_ADJUDICATOR_ID=${SOOTH_ADJUDICATOR_ID.toBase58()}`,
    ...(bookSingletons ? bookSingletonEnvLines(bookSingletons) : []),
    `VITE_USDC_MINT=${USDC_MINT_DEVNET.toBase58()}`,
    `VITE_DEMO_MARKET_REF=sol:${marketPda.toBase58()}`,
    `VITE_DEMO_LP_YIELD_VAULT=${lpYieldVaultAta.toBase58()}`,
    `# Pre-funded user pubkey (1000 USDC, 10 SOL). Import the keypair`,
    `# at apps/demo/.localnet/user-keypair.json into Phantom or Solflare`,
    `# (Settings → Add/Connect Wallet → Import Private Key) to test trades.`,
    `VITE_DEMO_AIRDROP_RECIPIENT=${user.publicKey.toBase58()}`,
    `# Mint authority secret bytes for the in-browser faucet (localnet only).`,
    `# Loaded by apps/demo/src/lib/chain-shim/amm-bridge.ts when the user`,
    `# clicks "Request 100,000 mUSDC" on /faucet.`,
    `VITE_TEST_MINT_AUTHORITY_BYTES=${mintAuthorityBytes}`,
    `# Allowlist authority secret bytes — used by the dapp to auto-register`,
    `# the connected wallet as an adjudicator on first connect (localnet only).`,
    `# Without this any wallet attempting createMarket / operator paths fails`,
    `# with sooth_market::AdjudicatorNotAllowlisted (6012).`,
    `VITE_TEST_AUTHORITY_BYTES=${allowlistAuthorityBytes}`,
    "",
  ].join("\n");
  writeFileSync(ENV_LOCAL_PATH, envBody);
  log(`wrote ${ENV_LOCAL_PATH}`);

  log("");
  log("=== Seed complete ===");
  log(`market PDA:    ${marketPda.toBase58()}`);
  log(`market ref:    sol:${marketPda.toBase58()}`);
  log(`user pubkey:   ${user.publicKey.toBase58()}`);
  log(`user keypair:  ${USER_KEYPAIR_PATH}`);
  log(
    `Import the user keypair into Phantom/Solflare to trade against the demo.`,
  );
}

// ─── Entry ────────────────────────────────────────────────────────────────
const phase = process.argv[2];
if (phase === "prepare") {
  await prepare();
} else if (phase === "init") {
  await init();
} else {
  die(
    "usage: node scripts/seed-localnet.mjs <prepare|init>\n" +
      "  prepare: pre-validator (writes mint dump JSON)\n" +
      "  init:    post-validator (creates market + funds user)",
  );
}
