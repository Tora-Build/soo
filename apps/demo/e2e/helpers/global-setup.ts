// Playwright globalSetup hook for the on-chain e2e suite.
//
// Runs ONCE before any spec. Pre-conditions:
//   - solana-test-validator running on $SOLANA_RPC_URL with the 4 sooth_*
//     program .so binaries deployed at their declare_id! pubkeys.
//   - apps/demo/scripts/seed-localnet.mjs init has been run, producing:
//       .localnet/mint-authority.json (USDC mint authority keypair)
//       .env.local with VITE_DEMO_MARKET_REF=sol:<marketPda>
//
// Responsibilities:
//   - Validate the validator is reachable.
//   - Validate the test wallet pubkey (TEST_PUBKEY) has SOL — airdrop if not.
//   - Mint enough USDC (default 1000) to the test wallet via the seed
//     script's mint authority.
//   - Read the seeded market PDA's market_id (16 bytes at offset 8) and
//     export it via process.env so spec(s) can derive Position PDAs.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
import { mintTokens } from "./onchain";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEMO_ROOT = resolve(__dirname, "..", "..");
const LOCALNET_DIR = resolve(DEMO_ROOT, ".localnet");
const MINT_AUTHORITY_PATH = resolve(LOCALNET_DIR, "mint-authority.json");
const CREATOR_KEYPAIR_PATH = resolve(LOCALNET_DIR, "creator-keypair.json");
const ENV_LOCAL_PATH = resolve(DEMO_ROOT, ".env.local");
const REPO_ROOT = resolve(DEMO_ROOT, "..", "..");
const SDK_ANCHOR_DIR = resolve(
  REPO_ROOT,
  "packages",
  "sdk-solana",
  "src",
  "anchor",
);

function log(msg: string): void {
  process.stdout.write(`[e2e-global-setup] ${msg}\n`);
}

function die(msg: string): never {
  process.stderr.write(`[e2e-global-setup] ERROR: ${msg}\n`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) die(`${name} env var required`);
  return v;
}

function readEnvLocal(): Record<string, string> {
  if (!existsSync(ENV_LOCAL_PATH)) {
    die(
      `.env.local missing — run \`pnpm -F @sooth/demo seed:init\` (after the validator is up)`,
    );
  }
  const raw = readFileSync(ENV_LOCAL_PATH, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

export default async function globalSetup(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
  const testPubkeyStr = requireEnv("TEST_PUBKEY");
  const testPubkey = new PublicKey(testPubkeyStr);

  const env = readEnvLocal();
  const usdcMintStr = env.VITE_USDC_MINT ?? requireEnv("USDC_MINT");
  // The AMM's token. Falls back to the SDK/program default rather than dying:
  // .env.local files written before the venue split do not carry the key.
  const ammMintStr =
    env.VITE_AMM_MINT ?? "CUsiEVc29hQa9xLBFB7nPQxP1aEiWq1cZkdfn8ATFHBu";
  // The app reads VITE_SOOTH_CORE_ID; the AMM alias is still written by the
  // seed for this assertion's benefit and points at the same program.
  const ammIdStr =
    env.VITE_SOOTH_CORE_ID ?? env.VITE_SOOTH_AMM_ID ?? requireEnv("SOOTH_CORE_ID");
  const marketRef = env.VITE_DEMO_MARKET_REF;
  if (!marketRef) {
    die(
      "VITE_DEMO_MARKET_REF missing from .env.local — re-run `pnpm -F @sooth/demo seed:init` against a healthy validator",
    );
  }
  const marketPdaStr = marketRef.replace(/^sol:/, "");
  const marketPda = new PublicKey(marketPdaStr);
  const usdcMint = new PublicKey(usdcMintStr);

  log(`rpc=${rpcUrl}`);
  log(`test wallet=${testPubkeyStr}`);
  log(`market PDA=${marketPdaStr}`);
  log(`book mint=${usdcMintStr}`);
  log(`amm mint=${ammMintStr}`);

  const conn = new Connection(rpcUrl, "confirmed");

  // Validator reachability
  try {
    await conn.getVersion();
  } catch (e) {
    die(
      `validator unreachable at ${rpcUrl}: ${(e as Error).message}. Boot solana-test-validator first.`,
    );
  }

  // Mint authority
  if (!existsSync(MINT_AUTHORITY_PATH)) {
    die(
      `${MINT_AUTHORITY_PATH} missing — run \`pnpm -F @sooth/demo seed:prepare && pnpm -F @sooth/demo seed:init\``,
    );
  }
  const mintAuthority = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(MINT_AUTHORITY_PATH, "utf8"))),
  );

  // Read on-chain Market account to extract market_id (16 bytes at offset 8)
  const marketInfo = await conn.getAccountInfo(marketPda);
  if (!marketInfo) {
    die(
      `Market PDA ${marketPdaStr} has no account on-chain — seed script may not have completed`,
    );
  }
  const marketIdBytes = marketInfo.data.subarray(8, 24);
  const marketIdHex = Buffer.from(marketIdBytes).toString("hex");
  log(`market_id (hex)=${marketIdHex}`);

  // Airdrop SOL if needed
  const solBalance = await conn.getBalance(testPubkey);
  if (solBalance < 1 * LAMPORTS_PER_SOL) {
    log(
      `airdropping 2 SOL to test wallet (current=${solBalance / LAMPORTS_PER_SOL} SOL)`,
    );
    const sig = await conn.requestAirdrop(testPubkey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  } else {
    log(`test wallet SOL OK (${solBalance / LAMPORTS_PER_SOL} SOL)`);
  }

  // Mint USDC to test wallet (idempotent — creates ATA if missing)
  const ata = getAssociatedTokenAddressSync(usdcMint, testPubkey);
  let beforeUsdc = 0n;
  try {
    const acc = await getAccount(conn, ata);
    beforeUsdc = acc.amount;
  } catch {
    // ATA may not exist yet; mintTokens will create it idempotently
  }
  const TARGET_USDC = 1_000_000_000n; // 1000 USDC (6 decimals)
  if (beforeUsdc < TARGET_USDC) {
    const toMint = TARGET_USDC - beforeUsdc;
    log(
      `minting ${toMint} USDC base units (current=${beforeUsdc}) using mintAuthority=${mintAuthority.publicKey.toBase58()}`,
    );
    await mintTokens(conn, mintAuthority, usdcMint, testPubkey, toMint);
  } else {
    log(`test wallet USDC OK (${beforeUsdc} base units)`);
  }

  // ─── seed_lp (idempotent gap-fill) ───────────────────────────────────
  //
  // trade_positions mints LP to the trader on every pre-graduation buy, which
  // needs the per-market `lp_mint` PDA to already exist as an SPL Mint. The
  // seed script does call seed_lp now, so this is a belt-and-braces gate for
  // ledgers seeded by an older script — it skips when lp_mint is present.
  // (Post-merge the CPI is a plain internal call, but the LP mint prerequisite
  // is unchanged.)
  await runSeedLpIfMissing({
    conn,
    marketPda,
    marketIdBytes,
    launchpadIdStr: env.VITE_SOOTH_CORE_ID ?? env.VITE_SOOTH_LAUNCHPAD_ID,
    usdcMint,
  });

  // globalSetup mutations of process.env do not propagate to test workers
  // (Playwright forks workers from the parent process snapshot). Persist
  // the derived values to a JSON file the spec reads at runtime.
  const fixturePath = resolve(__dirname, "..", ".e2e-fixture.json");
  writeFileSync(
    fixturePath,
    JSON.stringify(
      {
        marketPda: marketPdaStr,
        marketIdHex,
        soothAmmId: ammIdStr,
        usdcMint: usdcMintStr,
        ammMint: ammMintStr,
        rpcUrl,
      },
      null,
      2,
    ),
  );
  log(`wrote ${fixturePath}`);
  log("global setup complete");
}

// ─── seed_lp helper ──────────────────────────────────────────────────────
//
// Reads the Market PDA's `creator` field (offset 24, after disc + market_id),
// loads the matching keypair from `.localnet/creator-keypair.json`, builds
// an Anchor `seedLp` ix against the launchpad IDL, and submits it via the
// creator signer. Idempotent — checks `lp_mint` PDA presence first.

interface SeedLpInputs {
  conn: Connection;
  marketPda: PublicKey;
  marketIdBytes: Buffer;
  launchpadIdStr?: string;
  /** Required since bug B0: seed_lp now transfers the LMSR subsidy. */
  usdcMint: PublicKey;
}

async function runSeedLpIfMissing(inp: SeedLpInputs): Promise<void> {
  // Load the launchpad IDL from the SDK source tree (the SDK package's
  // `exports` map locks subpath imports, so we side-load via fs).
  // One program since the 5→1 merge — the LP mint, its authority and
  // lp_position all live under sooth_core now.
  const coreIdlPath = resolve(SDK_ANCHOR_DIR, "sooth_core.json");
  const coreIdl = JSON.parse(readFileSync(coreIdlPath, "utf8"));
  const launchpadId = new PublicKey(inp.launchpadIdStr ?? coreIdl.address);

  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), inp.marketIdBytes],
    launchpadId,
  );

  // Idempotent gate
  const lpMintInfo = await inp.conn.getAccountInfo(lpMint);
  if (lpMintInfo) {
    log(`seed_lp: lp_mint ${lpMint.toBase58()} already exists, skipping`);
    return;
  }

  if (!existsSync(CREATOR_KEYPAIR_PATH)) {
    die(
      `${CREATOR_KEYPAIR_PATH} missing — re-run seed:init to regenerate the creator keypair`,
    );
  }
  const creator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(CREATOR_KEYPAIR_PATH, "utf8"))),
  );

  // Verify the on-disk creator pubkey matches the Market.creator field.
  const marketInfo = await inp.conn.getAccountInfo(inp.marketPda);
  if (!marketInfo) die("Market PDA disappeared between init and seed_lp");
  const marketCreator = new PublicKey(marketInfo.data.subarray(24, 56));
  if (!marketCreator.equals(creator.publicKey)) {
    die(
      `Market.creator=${marketCreator.toBase58()} does not match on-disk creator=${creator.publicKey.toBase58()}`,
    );
  }

  const [lpMintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint_authority"), inp.marketIdBytes],
    launchpadId,
  );
  const [lpPosition] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("lp_position"),
      inp.marketIdBytes,
      creator.publicKey.toBuffer(),
    ],
    launchpadId,
  );
  const [protocolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    launchpadId,
  );
  const [ammStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm"), inp.marketIdBytes],
    new PublicKey(coreIdl.address) /* placeholder, overwritten below */,
  );
  // amm_state lives under the AMM program, not the launchpad — recompute.
  const ammIdlPath = resolve(SDK_ANCHOR_DIR, "sooth_amm.json");
  const ammIdl = JSON.parse(readFileSync(ammIdlPath, "utf8"));
  const ammProgramId = new PublicKey(ammIdl.address);
  const [ammStatePdaCorrect] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm"), inp.marketIdBytes],
    ammProgramId,
  );
  void ammStatePda; // satisfy lint — only the second derivation is used

  const creatorLpAta = getAssociatedTokenAddressSync(lpMint, creator.publicKey);

  // Mirror bootSmoke's seed inputs (architecture §4.2 1:1 rule).
  // bWad here is whatever the seed-init used; we recompute as 1000·WAD
  // (the localnet seed uses bWad = 1_000n * WAD = 1000e18, see
  // seed-localnet.mjs L347).
  const WAD = 1_000_000_000_000_000_000n;
  const bWad = 1_000n * WAD;
  const lpAmountBaseUnits = bWad / 1_000_000_000_000n; // 1_000_000

  const wallet = {
    publicKey: creator.publicKey,
    signTransaction: async (tx: any) => {
      tx.partialSign(creator);
      return tx;
    },
    signAllTransactions: async (txs: any[]) => {
      for (const tx of txs) tx.partialSign(creator);
      return txs;
    },
    payer: creator,
  };
  const provider = new anchor.AnchorProvider(inp.conn, wallet as any, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  // Override the launchpad IDL's `address` to the (potentially overridden)
  // launchpadId before constructing the Program (Anchor 0.30+ wires the
  // program id from `idl.address`).
  const idlForProgram = { ...coreIdl, address: launchpadId.toBase58() };
  const launchpadProgram = new anchor.Program(idlForProgram as any, provider);

  log(
    `seed_lp: minting ${lpAmountBaseUnits} LP base units to creator=${creator.publicKey.toBase58()}`,
  );
  const sig = await (launchpadProgram.methods as any)
    .seedLp({
      lpAmount: new anchor.BN(lpAmountBaseUnits.toString()),
      // Exactly the LMSR worst-case subsidy seed_lp now requires: b * ln(2).
      seedDepositWad: new anchor.BN(
        (
          (bWad * 693_147_180_559_945_309n) /
          1_000_000_000_000_000_000n
        ).toString(),
      ),
    })
    .accounts({
      config: protocolConfig,
      market: inp.marketPda,
      ammState: ammStatePdaCorrect,
      lpMint,
      lpMintAuthority,
      creatorLpAta,
      lpPosition,
      // seed_lp now transfers the LMSR subsidy into the market vault (B0).
      marketVault: getAssociatedTokenAddressSync(
        inp.usdcMint,
        PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), inp.marketIdBytes],
          launchpadId,
        )[0],
        true,
      ),
      creatorUsdcAta: getAssociatedTokenAddressSync(
        inp.usdcMint,
        creator.publicKey,
      ),
      usdcMint: inp.usdcMint,
      creator: creator.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([creator])
    .rpc();
  log(`seed_lp OK (sig=${sig})`);
}
