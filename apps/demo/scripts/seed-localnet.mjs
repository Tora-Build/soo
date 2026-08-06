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

// One program since the 5→1 merge, and still one now that sooth_log is gone:
// `buy` emits its durable OrdersFilled record by self-CPI (emit_cpi!) rather
// than invoking a second program.
const { soothCoreIdl } = await import(sdkUrl("anchor/index.js"));
const {
  deriveAmmStatePda,
  deriveFeePoolAuthorityPda,
  marketFeePoolPda,
  deriveFeePoolVaultAta,
  deriveLockAuthorityPda,
  deriveLockVaultAta,
  deriveMarketPda,
  deriveMarketVaultAta,
  deriveNoMintPda,
  deriveProtocolConfigPda,
  deriveVaultAuthorityPda,
  deriveYesMintPda,
  deriveAdjudicatorEntryPda,
  SOOTH_CORE_PROGRAM_ID,
} = await import(sdkUrl("pdas.js"));
const { WAD } = await import(sdkUrl("math/lmsr.js"));

// sooth_core installs a 256 KB #[global_allocator]. The runtime only maps that
// region when the transaction requests it, and the allocator addresses from the
// top of it, so WITHOUT this every instruction aborts with "Access violation in
// heap section" — not just multi-fill buys.
const SOOTH_CORE_HEAP_BYTES = 256 * 1024;
const heapFrameIx = () =>
  ComputeBudgetProgram.requestHeapFrame({ bytes: SOOTH_CORE_HEAP_BYTES });

function programIdOrFallback(idlAddress, fallback) {
  return idlAddress ? new PublicKey(idlAddress) : fallback;
}

const SOOTH_CORE_ID = programIdOrFallback(
  soothCoreIdl.address,
  SOOTH_CORE_PROGRAM_ID,
);
const soothCoreProgramIdl = {
  ...soothCoreIdl,
  address: SOOTH_CORE_ID.toBase58(),
};
const PROGRAMS = {
  soothCore: SOOTH_CORE_ID,
};

// Canonical USDC mint baked into the on-chain programs' `address = ...`
// constraint. The mint MUST exist at this address on the validator or
// initialize_market_vaults / trade_positions will fail.
const USDC_MINT_DEVNET = new PublicKey(
  "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX",
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
    SOOTH_CORE_ID,
  )[0];
}

function deriveBookMarketTypePda(name) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market_type"), Buffer.from(name)],
    SOOTH_CORE_ID,
  )[0];
}

function deriveBookAuthorisedOperatorsPda(operatorType) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("authorised_operators"), Buffer.from(operatorType)],
    SOOTH_CORE_ID,
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
    `VITE_SOOTH_BOOK_ID=${SOOTH_CORE_ID.toBase58()}`,
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

  // The creator now funds the LMSR subsidy in seed_lp (bug B0), so they need
  // real USDC of their own. b*ln(2) at b = 1000 is ~693.15 USDC.
  const creatorUsdcAta = getAssociatedTokenAddressSync(
    USDC_MINT_DEVNET,
    creator.publicKey,
  );
  if (!(await connection.getAccountInfo(creatorUsdcAta))) {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          creator.publicKey,
          creatorUsdcAta,
          creator.publicKey,
          USDC_MINT_DEVNET,
        ),
      ),
      [creator],
    );
  }
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      createMintToInstruction(
        USDC_MINT_DEVNET,
        creatorUsdcAta,
        mintAuthority.publicKey,
        10_000_000_000n, // 10,000 USDC
      ),
    ),
    [mintAuthority],
  );
  log(`minted 10,000 USDC to creator (LMSR subsidy funding)`);

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

  const marketProgram = new Program(soothCoreProgramIdl, provider);
  const launchpadProgram = new Program(soothCoreProgramIdl, provider);
  const adjudicatorProgram = new Program(soothCoreProgramIdl, provider);
  const bookProgram = new Program(soothCoreProgramIdl, provider);

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
  const [configPda] = deriveProtocolConfigPda(PROGRAMS);

  // Use chain time, not 1_000_000 sentinel (real validator wall clock).
  const startTime = Math.floor(Date.now() / 1000);
  // Trading deadline. `request_lock` refuses until `now >= deadline`, so a
  // week-long default makes the settlement path untestable on a localnet that
  // lives for minutes. Overridable so a market can be created that locks
  // almost immediately.
  const deadline =
    startTime + Number(process.env.SEED_DEADLINE_SECS ?? 7 * 24 * 60 * 60);
  // Liquidity parameter. Overridable because it decides two things that
  // matter for local testing:
  //
  //   - the LMSR subsidy the creator must post, b * ln(2) — ~693 USDC at
  //     b = 1000, which is real money the seed has to mint;
  //   - how much volume it takes to GRADUATE, since graduation fires when
  //     accumulated fees reach that same b * ln(2). At b = 1000 and a 1% fee
  //     that is ~69,300 USDC of trading, which no local session will reach —
  //     and the orderbook UI only unlocks once a market is graduated.
  //
  // SEED_B_WAD=1 gives a thin AMM that graduates after ~70 USDC of volume,
  // which is what makes the orderbook reachable on localnet.
  const bWad = BigInt(process.env.SEED_B_WAD ?? "1000") * WAD;

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
        // 2s: the e2e suite resolves, settles and redeems inside one run,
        // and solana-test-validator has no clock warp. Short, not zero —
        // zero is rejected on-chain precisely so an omitted arg cannot
        // silently disable the veto.
        vetoPeriodSecs: new BN(2),
      })
      .accounts({
        config: configPda,
        authority: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .preInstructions([heapFrameIx()])
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
  const [feePoolAuthorityPda] = deriveFeePoolAuthorityPda(PROGRAMS);
  const feePoolVault = deriveFeePoolVaultAta(USDC_MINT_DEVNET, PROGRAMS);
  // `initialize_fee_pool` is gone. The merge replaced the singleton fee-pool
  // vault with a PER-MARKET `market_fee_pool` created by
  // `init_market_fee_pool`, which needs a market to exist first — so there is
  // nothing to bootstrap globally. The authority PDA is still derived above
  // because distribute_fees reads it.
  void feePoolAuthorityPda;
  void feePoolVault;

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
    SOOTH_CORE_ID,
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
  // The global AdjudicatorAllowlist is gone: the merge deleted the account, its
  // seed, and the initialize/add instructions. sooth_core gates adjudicators on
  // the single ProtocolConfig.permissionless_adjudicators flag (true on
  // localnet) and registers them per-market via register_adjudicator, which
  // happens after market creation below.

  const demoAdjudicator = creator.publicKey;
  // `addAdjudicator` is gone with the allowlist; nothing to allow-list.

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
      vaultAuthority,
      yesMint,
      noMint,
      lockAuthority,
      usdcMint: USDC_MINT_DEVNET,
      vault,
      lockVault,
      ammState: ammStatePda,
      creator: creator.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      heapFrameIx(),
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
  const [adjudicatorPda] = deriveAdjudicatorEntryPda(marketPda, PROGRAMS);
  const adjudicatorInfo = await connection.getAccountInfo(adjudicatorPda);
  if (!adjudicatorInfo) {
    await adjudicatorProgram.methods
      // AdjudicatorKind is gone, so no variant argument.
      .registerAdjudicator(demoAdjudicator)
      .accounts({
        adjudicatorEntry: adjudicatorPda,
        protocolConfig: configPda,
        market: marketPda,
        signer: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .preInstructions([heapFrameIx()])
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
      creator.publicKey.toBuffer(),
    ],
    SOOTH_CORE_ID,
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
        // Exactly the LMSR worst-case subsidy the program requires: b * ln(2).
        seedDepositWad: new BN(
          ((bWad * 693_147_180_559_945_309n) / 1_000_000_000_000_000_000n).toString(),
        ),
      })
      .accounts({
        config: configPda,
        market: marketPda,
        ammState: ammStatePda,
        lpMint: lpMintPda,
        lpMintAuthority: lpMintAuthorityPda,
        creatorLpAta,
        lpPosition: lpPositionPda,
        // seed_lp now transfers the LMSR subsidy (b*ln 2) into the market
        // vault — before bug B0 was fixed it recorded seed_deposit_wad and
        // moved nothing, leaving the vault unable to pay winners.
        marketVault: vault,
        creatorUsdcAta,
        usdcMint: USDC_MINT_DEVNET,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([creator])
      .preInstructions([heapFrameIx()])
      .rpc();
    log(
      `  seedLp OK (lp_mint=${lpMintPda.toBase58()}, lp_amount=${lpAmountBaseUnits} base units)`,
    );
  } else {
    log(`  lp_mint ${lpMintPda.toBase58()} already exists, skipping seedLp`);
  }
  // ─── init_market_fee_pool ──────────────────────────────────────────────
  //
  // Per-market fee destination for both venues. Every trading instruction
  // takes it as an account, so without it `buy`, `book_place` and
  // `trade_positions` all fail with AccountNotInitialized — the seed script
  // was creating a market nobody could trade on.
  const [marketFeePoolPdaAddr] = marketFeePoolPda(marketId, PROGRAMS);
  if (!(await connection.getAccountInfo(marketFeePoolPdaAddr))) {
    await launchpadProgram.methods
      .initMarketFeePool()
      .accounts({
        market: marketPda,
        feePoolAuthority: feePoolAuthorityPda,
        usdcMint: USDC_MINT_DEVNET,
        marketFeePool: marketFeePoolPdaAddr,
        signer: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([creator])
      .preInstructions([heapFrameIx()])
      .rpc();
    log(`  initMarketFeePool OK (${marketFeePoolPdaAddr.toBase58()})`);
  } else {
    log(`  market_fee_pool already present, skipping`);
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

  // Carry forward markets from earlier seed runs.
  //
  // The demo has no on-chain market registry — `getMarkets` is served from the
  // env — and this file is rewritten wholesale on every run. Without this, each
  // run silently orphans the previous market: it still exists on the validator,
  // but nothing in the UI can reach it. That matters because a realistic
  // localnet needs BOTH a bonding market (large b, realistic price impact) and
  // a graduated one (small b, reachable graduation), which is two runs.
  const carriedMarketRefs = (() => {
    if (!existsSync(ENV_LOCAL_PATH)) return [];
    const prior = readFileSync(ENV_LOCAL_PATH, "utf8");
    const previousMain = prior.match(/^VITE_DEMO_MARKET_REF=(.*)$/m)?.[1]?.trim();
    const previousExtras = (
      prior.match(/^VITE_DEMO_EXTRA_MARKET_REFS=(.*)$/m)?.[1] ?? ""
    )
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    const nextRef = `sol:${marketPda.toBase58()}`;
    return [...new Set([previousMain, ...previousExtras].filter(Boolean))].filter(
      (r) => r !== nextRef,
    );
  })();

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
    `# ONE program id since the merge. \`src/lib/config.ts\` reads exactly`,
    `# this key — the pre-merge VITE_SOOTH_AMM_ID / _MARKET_ID / _ADJUDICATOR_ID`,
    `# it used to write are read by nothing, so every override was silently`,
    `# ignored and the demo fell back to the SDK's compiled-in default id.`,
    `VITE_SOOTH_CORE_ID=${SOOTH_CORE_ID.toBase58()}`,
    ...(bookSingletons ? bookSingletonEnvLines(bookSingletons) : []),
    `VITE_USDC_MINT=${USDC_MINT_DEVNET.toBase58()}`,
    `VITE_DEMO_MARKET_REF=sol:${marketPda.toBase58()}`,
    `# Extra markets listed alongside the seeded one. Each seed run rewrites`,
    `# this file, so markets from earlier runs are carried forward here rather`,
    `# than becoming unreachable through the UI (there is no on-chain registry).`,
    `VITE_DEMO_EXTRA_MARKET_REFS=${carriedMarketRefs.join(",")}`,
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
    `# ── Local Keypair wallet ────────────────────────────────────────────`,
    `#`,
    `# Enables the in-app "Local Keypair" wallet, which signs with the`,
    `# pre-funded user below instead of a browser extension.`,
    `#`,
    `# This is the right way to test on localnet. Phantom's "unsafe`,
    `# transaction" warning comes from its SERVER-SIDE security scanner,`,
    `# which cannot reach a validator on your machine — so it reports every`,
    `# localnet transaction as unsimulatable no matter what the transaction`,
    `# does. The tx still lands if you confirm past it; the warning is about`,
    `# Phantom's reachability, not your transaction.`,
    `#`,
    `# vite.config.ts throws if a production build is attempted with this on.`,
    `VITE_TEST_MODE=true`,
    `VITE_TEST_KEYPAIR_BYTES=${JSON.stringify(Array.from(user.secretKey))}`,
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
