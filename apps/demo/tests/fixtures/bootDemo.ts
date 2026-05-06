// Demo-side bankrun fixture. Re-exports the SDK's existing `bootSmoke` from
// `@sooth/sdk-solana/tests/fixtures/setup` is the cleanest option, but that
// path is not part of the package's "exports" map (`packages/sdk-solana/
// package.json` ships only `dist`). Importing from a deep path would need
// `package.json` changes there — out of scope for this task.
//
// We resolve the .so binaries from the workspace root (the SDK does the
// same — its `BPF_OUT_DIR` resolution walks up from the package). The bankrun
// boot logic + Anchor-driven init flow is duplicated. If the SDK formalizes
// a `tests/fixtures` export later, this file shrinks to a re-export.
//
// Reported in the task summary as a "missing public export" recommendation.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { Clock, start, type ProgramTestContext } from "solana-bankrun";

import {
  WAD,
  deriveAmmStatePda,
  deriveLockAuthorityPda,
  deriveLockVaultAta,
  deriveMarketPda,
  deriveMarketVaultAta,
  deriveNoMintPda,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  deriveYesMintPda,
  soothAmmIdl,
  soothMarketIdl,
  type ProgramIds,
} from "@sooth/sdk-solana";

import { BankrunConnectionShim } from "./BankrunConnectionShim";

// Workspace root: apps/demo/tests/fixtures → ../../../..
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

export const SOOTH_AMM_ID = new PublicKey(soothAmmIdl.address);
export const SOOTH_MARKET_ID = new PublicKey(soothMarketIdl.address);
export const PROGRAMS: ProgramIds = {
  soothAmm: SOOTH_AMM_ID,
  soothMarket: SOOTH_MARKET_ID,
};

const USDC_MINT_DEVNET = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

export interface DemoBootContext {
  ctx: ProgramTestContext;
  connection: BankrunConnectionShim;
  programs: ProgramIds;
  usdcMint: PublicKey;
  user: Keypair;
  marketPda: PublicKey;
}

export interface DemoBootOpts {
  bWad?: bigint;
  userUsdcBaseUnits?: bigint;
}

export async function bootDemo(
  opts: DemoBootOpts = {},
): Promise<DemoBootContext> {
  const bWad = opts.bWad ?? 1_000n * WAD;
  const userUsdc = opts.userUsdcBaseUnits ?? 100_000_000n; // 100 USDC

  const soDir = resolve(REPO_ROOT, "target", "deploy");
  process.env.BPF_OUT_DIR = soDir;
  for (const so of ["sooth_amm.so", "sooth_market.so"]) {
    try {
      readFileSync(resolve(soDir, so));
    } catch {
      throw new Error(
        `bootDemo: missing ${so} in ${soDir}. Run \`cargo build-sbf\` from the workspace root first.`,
      );
    }
  }

  const ctx = await start(
    [
      { name: "sooth_amm", programId: SOOTH_AMM_ID },
      { name: "sooth_market", programId: SOOTH_MARKET_ID },
    ],
    [],
    1_400_000n,
  );

  const mintAuthority = Keypair.generate();
  await writeMint(ctx, USDC_MINT_DEVNET, mintAuthority.publicKey);

  const creator = Keypair.generate();
  const user = Keypair.generate();
  await fundLamports(ctx, creator.publicKey, 5n * BigInt(LAMPORTS_PER_SOL));
  await fundLamports(ctx, user.publicKey, 5n * BigInt(LAMPORTS_PER_SOL));
  await fundLamports(
    ctx,
    mintAuthority.publicKey,
    5n * BigInt(LAMPORTS_PER_SOL),
  );

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

  const conn = new BankrunConnectionShim(ctx);
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
  const provider = new AnchorProvider(conn as never, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const marketProgram = new Program(soothMarketIdl as Idl, provider);
  const ammProgram = new Program(soothAmmIdl as Idl, provider);

  const marketId = randomMarketId();
  const [marketPda] = deriveMarketPda(marketId, PROGRAMS);
  const [vaultAuthority] = deriveVaultAuthorityPda(marketId, PROGRAMS);
  const [lockAuthority] = deriveLockAuthorityPda(marketId, PROGRAMS);
  const [yesMint] = deriveYesMintPda(marketId, PROGRAMS);
  const [noMint] = deriveNoMintPda(marketId, PROGRAMS);
  const vault = deriveMarketVaultAta(marketId, USDC_MINT_DEVNET, PROGRAMS);
  const lockVault = deriveLockVaultAta(marketId, USDC_MINT_DEVNET, PROGRAMS);

  const startTime = 1_000_000;
  const deadline = startTime + 7 * 24 * 60 * 60;

  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (
          marketProgram.methods as never as Record<
            string,
            (...a: unknown[]) => {
              accounts: (a: unknown) => {
                instruction: () => Promise<TransactionInstruction>;
              };
            }
          >
        )
          .initializeMarket({
            marketId: Array.from(marketId),
            questionHash: Array(32).fill(0),
            startTime: new BN(startTime),
            deadline: new BN(deadline),
            adjudicator: PublicKey.default,
          })
          .accounts({
            market: marketPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ],
      creator.publicKey,
    ),
  );

  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (
          marketProgram.methods as never as Record<
            string,
            () => {
              accounts: (a: unknown) => {
                instruction: () => Promise<TransactionInstruction>;
              };
            }
          >
        )
          .initializeOutcomeMints()
          .accounts({
            market: marketPda,
            vaultAuthority,
            yesMint,
            noMint,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .instruction(),
      ],
      creator.publicKey,
    ),
  );

  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (
          marketProgram.methods as never as Record<
            string,
            () => {
              accounts: (a: unknown) => {
                instruction: () => Promise<TransactionInstruction>;
              };
            }
          >
        )
          .initializeMarketVaults()
          .accounts({
            market: marketPda,
            vaultAuthority,
            lockAuthority,
            usdcMint: USDC_MINT_DEVNET,
            vault,
            lockVault,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .instruction(),
      ],
      creator.publicKey,
    ),
  );

  // C1 (Codex): warp bankrun's clock past `startTime` so the trade-window
  // guard in `trade_positions` (`now >= start_time`) passes. See the
  // matching note in `packages/sdk-solana/tests/fixtures/setup.ts`.
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

  const [ammStatePda] = deriveAmmStatePda(marketId, PROGRAMS);
  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (
          ammProgram.methods as never as Record<
            string,
            (a: unknown) => {
              accounts: (a: unknown) => {
                instruction: () => Promise<TransactionInstruction>;
              };
            }
          >
        )
          .initializeAmmState({
            initialB: new BN(bWad.toString()),
            trialEndAt: new BN(deadline),
          })
          .accounts({
            market: marketPda,
            ammState: ammStatePda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ],
      creator.publicKey,
    ),
  );

  return {
    ctx,
    connection: conn,
    programs: PROGRAMS,
    usdcMint: USDC_MINT_DEVNET,
    user,
    marketPda,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────

function randomMarketId(): Uint8Array {
  const id = new Uint8Array(16);
  for (let i = 0; i < 16; i++) id[i] = (Math.random() * 256) | 0;
  return id;
}

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

async function buildTx(
  ctx: ProgramTestContext,
  ixs: TransactionInstruction[],
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
