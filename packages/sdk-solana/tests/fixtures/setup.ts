// Shared smoke-test setup. Boots bankrun with the merged `sooth_core`
// program deployed at its `declare_id!` address, prepares a USDC mint, and
// pre-funds a test user. Drives the real on-chain init instructions end-to-
// end (create_market → register_adjudicator → seed_lp) — no `setAccount`
// shortcuts.
//
// Why the placeholder address:
//   `declare_id!("BgcooFgTuDQ…")` in `programs/sooth-core/src/lib.rs` bakes
//   the placeholder into the .so binary. Anchor's runtime checks
//   `program_id == crate::ID`, so the program must execute at its declared ID.
//
// USDC mint sleight-of-hand:
//   The on-chain `usdc_mint` accounts are constrained to the canonical
//   `USDC_MINT_DEVNET` address. Bankrun lets us hand-write a Mint account
//   *at that address* with our own mint authority — that's the one
//   non-bypass setAccount we keep, because it's a fixture (devnet USDC isn't
//   on bankrun) rather than a workaround for a missing on-chain feature.

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AnchorProvider,
  BN,
  Program,
  type Idl,
  type Wallet,
} from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MintLayout,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  type VersionedTransaction,
} from "@solana/web3.js";
import { Clock, start, type ProgramTestContext } from "solana-bankrun";

import { soothCoreIdl } from "../../src/anchor/index.js";
import {
  deriveAdjudicatorEntryPda,
  deriveAmmStatePda,
  deriveLockAuthorityPda,
  deriveLockVaultAta,
  deriveLpMintAuthorityPda,
  deriveLpMintPda,
  deriveLpPositionPda,
  deriveMarketPda,
  deriveMarketVaultAta,
  deriveNoMintPda,
  deriveProtocolConfigPda,
  deriveUserUsdcAta,
  deriveUserLpAta,
  deriveVaultAuthorityPda,
  deriveYesMintPda,
  marketFeePoolPda,
  SOOTH_CORE_PROGRAM_ID,
  type ProgramIds,
} from "../../src/pdas.js";
import { WAD } from "../../src/math/lmsr.js";
import { BankrunConnection } from "./bankrun-connection.js";

// Workspace root, derived from this file's location.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

// Single merged program ID.
export const SOOTH_CORE_ID = new PublicKey(soothCoreIdl.address);

export const PROGRAMS: ProgramIds = {
  soothCore: SOOTH_CORE_ID,
};

export interface SmokeContext {
  ctx: ProgramTestContext;
  programs: ProgramIds;
  usdcMint: PublicKey;
  user: Keypair;
  creator: Keypair;
  marketId: Uint8Array;
  marketPda: PublicKey;
  ammStatePda: PublicKey;
}

export interface SmokeOptions {
  // Initial liquidity parameter `b` in WAD. Default 1000·WAD — same as the
  // LMSR golden test.
  bWad?: bigint;
  // Initial USDC balance for the test user (in base units; 1e6 = 1 USDC).
  userUsdcBaseUnits?: bigint;
}

// Boot bankrun with sooth_core + the SPL token program. Returns a context
// pre-loaded with:
//   - a USDC mint owned by `payer`
//   - a funded test `user` Keypair with USDC ATA
//   - a `Market` PDA created via `sooth_core::create_market`
//   - an `AdjudicatorEntry` PDA created via `sooth_core::register_adjudicator`
//   - an `AmmState` PDA (created inside create_market)
//   - LP mint + creator allocation via `sooth_core::seed_lp`
export async function bootSmoke(
  opts: SmokeOptions = {},
): Promise<SmokeContext> {
  const bWad = opts.bWad ?? 1_000n * WAD;
  const userUsdc = opts.userUsdcBaseUnits ?? 100_000_000n; // 100 USDC

  // Resolve .so paths and load bytes. `start()` accepts the program name
  // alone; bankrun's underlying `solana-program-test` searches
  // `BPF_OUT_DIR`. We point that env var at the workspace's
  // `target/deploy/` before calling `start`.
  const soDir = resolveDeployDir();
  process.env.BPF_OUT_DIR = soDir;
  // Sanity-check that the .so file exists; fail fast with a clear message
  // if it doesn't (means `cargo build-sbf` hasn't been run for this commit).
  try {
    readFileSync(resolve(soDir, "sooth_core.so"));
  } catch {
    throw new Error(
      `smoke test: missing sooth_core.so in ${soDir}. Run \`cargo build-sbf\` from the workspace root or anchor build in packages/programs-core first.`,
    );
  }

  const ctx = await start(
    [{ name: "sooth_core", programId: SOOTH_CORE_ID }],
    [],
    /* computeMaxUnits */ 1_400_000n,
  );

  // ─── Mint a fresh USDC at the canonical devnet address ────────────────
  // We can't use the real devnet USDC mint because `create_market` and
  // `trade_positions` constrain `usdc_mint` against `USDC_MINT_DEVNET`.
  // We hand-write the mint *at that address* using setAccount.
  const USDC_MINT_DEVNET = new PublicKey(
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  );
  const mintAuthority = Keypair.generate();
  await writeMint(ctx, USDC_MINT_DEVNET, mintAuthority.publicKey);

  // ─── Test users ─────────────────────────────────────────────────────────
  const creator = Keypair.generate();
  const user = Keypair.generate();
  await fundLamports(ctx, creator.publicKey, 5n * BigInt(LAMPORTS_PER_SOL));
  await fundLamports(ctx, user.publicKey, 5n * BigInt(LAMPORTS_PER_SOL));
  await fundLamports(
    ctx,
    mintAuthority.publicKey,
    5n * BigInt(LAMPORTS_PER_SOL),
  );

  // Create user's USDC ATA + mint USDC into it. Mint authority signs.
  const userAta = deriveUserUsdcAta(user.publicKey, USDC_MINT_DEVNET);
  await sendTx(
    ctx,
    [creator],
    new Transaction().add(
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        userAta,
        user.publicKey,
        USDC_MINT_DEVNET,
      ),
    ),
  );
  await sendTx(
    ctx,
    [mintAuthority],
    new Transaction().add(
      createMintToInstruction(
        USDC_MINT_DEVNET,
        userAta,
        mintAuthority.publicKey,
        userUsdc,
      ),
    ),
  );

  // ─── Build Anchor `Program` handle bound to bankrun ─────────────────────
  // Anchor needs a Provider; the BankrunConnection forwards getAccountInfo /
  // sendRawTransaction / etc. to bankrun's BanksClient.
  const conn = new BankrunConnection(ctx);
  const wallet: Wallet = {
    publicKey: creator.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(
      tx: T,
    ): Promise<T> => {
      (tx as Transaction).partialSign(creator);
      return tx;
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(
      txs: T[],
    ): Promise<T[]> => {
      for (const tx of txs) (tx as Transaction).partialSign(creator);
      return txs;
    },
    payer: creator,
  };
  const provider = new AnchorProvider(conn, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const coreProgram = new Program(soothCoreIdl as Idl, provider);

  // ─── 0b. Initialize protocol (ProtocolConfig singleton) ──────────────────
  const [protocolConfigPda] = deriveProtocolConfigPda(PROGRAMS);
  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (coreProgram.methods as any)
          .initializeProtocol({
            feeBps: 100, // 1%
            treasury: creator.publicKey,
            bBaseShareBps: 5_000,
            lpYieldShareBps: 3_000,
            adjudicatorShareBps: 1_000,
            protocolShareBps: 1_000,
            defaultTrialPeriod: new BN(7 * 24 * 60 * 60),
            permissionlessAdjudicators: true,
          })
          .accounts({
            config: protocolConfigPda,
            authority: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ],
      creator.publicKey,
    ),
  );

  // ─── 1. create_market (one-shot: Market + mints + vaults + AmmState) ─────
  const marketId = randomMarketId();
  const [marketPda] = deriveMarketPda(marketId, PROGRAMS);
  const [vaultAuthority] = deriveVaultAuthorityPda(marketId, PROGRAMS);
  const [lockAuthority] = deriveLockAuthorityPda(marketId, PROGRAMS);
  const [yesMint] = deriveYesMintPda(marketId, PROGRAMS);
  const [noMint] = deriveNoMintPda(marketId, PROGRAMS);
  const vault = deriveMarketVaultAta(marketId, USDC_MINT_DEVNET, PROGRAMS);
  const lockVault = deriveLockVaultAta(marketId, USDC_MINT_DEVNET, PROGRAMS);
  const [ammStatePda] = deriveAmmStatePda(marketId, PROGRAMS);

  const startTime = 1_000_000;
  const deadline = startTime + 7 * 24 * 60 * 60;

  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (coreProgram.methods as any)
          .createMarket({
            marketId: Array.from(marketId),
            questionHash: Array(32).fill(0),
            startTime: new BN(startTime),
            deadline: new BN(deadline),
            adjudicator: creator.publicKey,
            initialB: bigIntToBn(bWad),
          })
          .accounts({
            config: protocolConfigPda,
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
          .instruction(),
      ],
      creator.publicKey,
    ),
  );

  // ─── 2. register_adjudicator ─────────────────────────────────────────────
  // Sets up the per-market AdjudicatorEntry PDA — needed for attest/settle.
  const [adjudicatorEntryPda] = deriveAdjudicatorEntryPda(marketPda, PROGRAMS);
  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (coreProgram.methods as any)
          .registerAdjudicator(creator.publicKey)
          .accounts({
            adjudicatorEntry: adjudicatorEntryPda,
            market: marketPda,
            protocolConfig: protocolConfigPda,
            signer: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ],
      creator.publicKey,
    ),
  );

  // ─── Advance bankrun's clock past `startTime` ──────────────────────────
  // C1 (Codex) added a `start_time <= now < deadline` guard to
  // `trade_positions`. Bankrun boots with `unix_timestamp = 0`; warp the
  // sysvar clock to a slot inside the trading window so the buy path can
  // execute. We pick `startTime + 1` as the smallest legal value.
  const existingClock = await ctx.banksClient.getClock();
  ctx.setClock(
    new Clock(
      existingClock.slot,
      existingClock.epochStartTimestamp,
      existingClock.epoch,
      existingClock.leaderScheduleEpoch,
      BigInt(startTime + 1),
    ),
  );

  // ─── 3. seed_lp — bootstrap per-market LP mint + creator allocation ────
  const [lpMint] = deriveLpMintPda(marketId, PROGRAMS);
  const [lpMintAuthority] = deriveLpMintAuthorityPda(marketId, PROGRAMS);
  const [lpPosition] = deriveLpPositionPda(marketId, creator.publicKey, PROGRAMS);
  const creatorLpAta = deriveUserLpAta(creator.publicKey, lpMint);
  const lpAmountBaseUnits = bWad / 1_000_000_000_000n;
  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (coreProgram.methods as any)
          .seedLp({
            lpAmount: bigIntToBn(lpAmountBaseUnits),
            seedDepositWad: bigIntToBn(bWad),
          })
          .accounts({
            config: protocolConfigPda,
            market: marketPda,
            ammState: ammStatePda,
            lpMint,
            lpMintAuthority,
            creatorLpAta,
            lpPosition,
            creator: creator.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .instruction(),
      ],
      creator.publicKey,
    ),
  );

  return {
    ctx,
    programs: PROGRAMS,
    usdcMint: USDC_MINT_DEVNET,
    user,
    creator,
    marketId,
    marketPda,
    ammStatePda,
  };
}

export function resolveDeployDir(): string {
  const candidates = [
    resolve(REPO_ROOT, "target", "deploy"),
    resolve(REPO_ROOT, "..", "..", "..", "target", "deploy"),
  ];
  return (
    candidates.find((candidate) =>
      existsSync(resolve(candidate, "sooth_core.so")),
    ) ?? candidates[0]
  );
}

// ─── Internals ────────────────────────────────────────────────────────────

function randomMarketId(): Uint8Array {
  const id = new Uint8Array(16);
  for (let i = 0; i < 16; i++) id[i] = (Math.random() * 256) | 0;
  return id;
}

function bigIntToBn(v: bigint): BN {
  return new BN(v.toString());
}

// bankrun's TS surface declares `AccountInfo<Uint8Array>` (web3 shape) where
// `lamports` is `number` and `rentEpoch` is `number`. The underlying NAPI
// binding actually accepts bigint at runtime — and we want bigint for
// lamport math anyway. Centralize the cast so individual writers stay clean.
function setAcc(
  ctx: ProgramTestContext,
  address: PublicKey,
  init: {
    executable: boolean;
    owner: PublicKey;
    lamports: bigint;
    data: Uint8Array;
    rentEpoch?: bigint;
  },
): void {
  ctx.setAccount(address, {
    executable: init.executable,
    owner: init.owner,
    lamports: init.lamports as unknown as number,
    data: init.data,
    rentEpoch: (init.rentEpoch ?? 0n) as unknown as number,
  });
}

async function fundLamports(
  ctx: ProgramTestContext,
  to: PublicKey,
  lamports: bigint,
): Promise<void> {
  const acc = await ctx.banksClient.getAccount(to);
  const existing = acc ? BigInt(acc.lamports as unknown as number) : 0n;
  setAcc(ctx, to, {
    executable: false,
    owner: SystemProgram.programId,
    lamports: existing + lamports,
    data: acc?.data ?? new Uint8Array(0),
  });
}

async function writeMint(
  ctx: ProgramTestContext,
  mint: PublicKey,
  authority: PublicKey,
): Promise<void> {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority: authority,
      supply: BigInt(0),
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  const rent = await ctx.banksClient.getRent();
  const lamports = rent.minimumBalance(BigInt(data.length));
  setAcc(ctx, mint, {
    executable: false,
    owner: TOKEN_PROGRAM_ID,
    lamports,
    data,
  });
}

async function sendTx(
  ctx: ProgramTestContext,
  signers: Keypair[],
  tx: Transaction,
): Promise<void> {
  if (!tx.recentBlockhash) {
    const blockhash = await ctx.banksClient.getLatestBlockhash();
    if (!blockhash) throw new Error("no blockhash");
    tx.recentBlockhash = blockhash[0];
  }
  if (!tx.feePayer && signers.length > 0) tx.feePayer = signers[0]!.publicKey;
  if (signers.length > 0) tx.sign(...signers);
  await ctx.banksClient.processTransaction(tx);
}

// Assemble a Transaction from a list of instructions.
async function buildTx(
  ctx: ProgramTestContext,
  ixs: Array<TransactionInstruction>,
  feePayer: PublicKey,
): Promise<Transaction> {
  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix);
  const blockhash = await ctx.banksClient.getLatestBlockhash();
  if (!blockhash) throw new Error("no blockhash");
  tx.recentBlockhash = blockhash[0];
  tx.feePayer = feePayer;
  return tx;
}
