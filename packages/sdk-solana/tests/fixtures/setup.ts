// Shared smoke-test setup. Boots LiteSVM with the merged `sooth_core`
// program deployed at its `declare_id!` address, prepares a USDC mint, and
// pre-funds a test user. Drives the real on-chain init instructions end-to-
// end (create_market → register_adjudicator → seed_lp) — no `setAccount`
// shortcuts.
//
// Why it deploys at the declared address:
//   `declare_id!` in `programs/sooth-core/src/lib.rs` bakes the id into the
//   .so binary, and Anchor's runtime checks `program_id == crate::ID`, so the
//   program must execute at exactly that address. Read it from the source
//   rather than repeating it here — a copy goes stale on the next deploy and
//   fails as "every instruction rejected", which looks nothing like a wrong
//   constant.
//
// USDC mint sleight-of-hand:
//   The on-chain `usdc_mint` accounts are constrained to the canonical
//   `USDC_MINT_DEVNET` address. LiteSVM lets us hand-write a Mint account
//   *at that address* with our own mint authority — that's the one
//   non-bypass setAccount we keep, because it's a fixture (devnet USDC isn't
//   on LiteSVM) rather than a workaround for a missing on-chain feature.

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
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  type VersionedTransaction,
} from "@solana/web3.js";
import { Clock, startSvm, type SvmContext } from "./svm.js";

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
import { LiteSvmConnection } from "./svm.js";

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
  ctx: SvmContext;
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
  // Leave the `AdjudicatorEntry` PDA uncreated so a test can drive
  // `register_adjudicator` itself (including its rejection paths — the PDA is
  // `init`, so it can only be registered once per market).
  skipRegisterAdjudicator?: boolean;
  // `ProtocolConfig.permissionless_adjudicators`. Default true (any market
  // creator may register). Set false to exercise the permissioned branch,
  // where only `config.authority` may register.
  permissionlessAdjudicators?: boolean;
  // Guardian-veto window in seconds. Default 24h, matching the intended
  // devnet/mainnet config. Tests that need to cross the window use
  // `warpClockTo`; set 0 here only to assert the no-window behaviour.
  vetoPeriodSecs?: number;
}

// Boot LiteSVM with sooth_core deployed. Returns a context
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

  // startSvm loads the .so directly and fails fast with a clear message if it
  // is missing (i.e. `anchor build` has not been run for this commit).
  const soDir = resolveDeployDir();
  try {
    readFileSync(resolve(soDir, "sooth_core.so"));
  } catch {
    throw new Error(
      `smoke test: missing sooth_core.so in ${soDir}. Run \`cargo build-sbf\` from the workspace root or anchor build in packages/programs-core first.`,
    );
  }

  // One program. `buy` used to invoke a separate `sooth_log` for the durable
  // OrdersFilled record; it now self-invokes via Anchor's `emit_cpi!`, so
  // there is no second .so to load.
  const ctx = startSvm([{ name: "sooth_core", programId: SOOTH_CORE_ID }], soDir);

  // ─── Mint a fresh USDC at the canonical devnet address ────────────────
  // We can't use the real devnet USDC mint because `create_market` and
  // `trade_positions` constrain `usdc_mint` against `USDC_MINT_DEVNET`.
  // We hand-write the mint *at that address* using setAccount.
  const USDC_MINT_DEVNET = new PublicKey(
    "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX",
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

  // The creator must now fund the LMSR subsidy in seed_lp (bug B0), so they
  // need real USDC. b*ln(2) at b = 1000 is ~693 USDC; mint generously so a
  // caller raising bWad does not silently hit InsufficientSeedDeposit.
  const creatorAta = deriveUserUsdcAta(creator.publicKey, USDC_MINT_DEVNET);
  await sendTx(
    ctx,
    [creator],
    new Transaction().add(
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        creatorAta,
        creator.publicKey,
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
        creatorAta,
        mintAuthority.publicKey,
        10_000_000_000n, // 10,000 USDC
      ),
    ),
  );

  // ─── Build Anchor `Program` handle bound to LiteSVM ────────────────────
  // Anchor needs a Provider; the LiteSvmConnection forwards getAccountInfo /
  // sendRawTransaction / etc. to the LiteSVM client.
  const conn = new LiteSvmConnection(ctx);
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
            ammFeeBps: 500,  // 5% — the incubation venue
            bookFeeBps: 100, // 1% — the mature venue
            treasury: creator.publicKey,
            bBaseShareBps: 5_000,
            lpYieldShareBps: 3_000,
            adjudicatorShareBps: 1_000,
            protocolShareBps: 1_000,
            defaultTrialPeriod: new BN(7 * 24 * 60 * 60),
            permissionlessAdjudicators: opts.permissionlessAdjudicators ?? true,
            vetoPeriodSecs: new BN((opts.vetoPeriodSecs ?? 24 * 60 * 60).toString()),
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

  // Set the clock BEFORE create_market so the market is created at a sane
  // `now`. This matters because `trial_end_at` is computed from the creation
  // timestamp (create_market.rs::compute_trial_end_at).
  //
  // The previous LiteSVM fixture got this wrong and nobody noticed: LiteSVM's
  // genesis clock is real wall-clock time (~1.79e9), so create_market ran
  // against a deadline of 1_604_800 that had ALREADY PASSED, and the clock
  // was then warped backwards into the trading window. `until_deadline <= 0`
  // made trial_end_at collapse to `now`, which is why trial-period assertions
  // happened to pass. LiteSVM boots at 0, which surfaced the inconsistency.
  warpClockTo(ctx, BigInt(startTime));

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
  if (!opts.skipRegisterAdjudicator)
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

  // ─── Advance the clock past `startTime` ────────────────────────────────
  // C1 (Codex) added a `start_time <= now < deadline` guard to
  // `trade_positions`. The SVM boots with `unix_timestamp = 0`; warp the
  // sysvar clock to a slot inside the trading window so the buy path can
  // execute. We pick `startTime + 1` as the smallest legal value.
  warpClockTo(ctx, BigInt(startTime + 1));

  // ─── 3. seed_lp — bootstrap per-market LP mint + creator allocation ────
  const [lpMint] = deriveLpMintPda(marketId, PROGRAMS);
  const [lpMintAuthority] = deriveLpMintAuthorityPda(marketId, PROGRAMS);
  const [lpPosition] = deriveLpPositionPda(
    marketId,
    creator.publicKey,
    PROGRAMS,
  );
  const creatorLpAta = deriveUserLpAta(creator.publicKey, lpMint);
  const lpAmountBaseUnits = bWad / 1_000_000_000_000n;
  // Exactly the LMSR worst-case subsidy the program now requires: b * ln(2).
  const LN2_WAD = 693_147_180_559_945_309n;
  const seedDepositWad = (bWad * LN2_WAD) / WAD;
  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (coreProgram.methods as any)
          .seedLp({
            lpAmount: bigIntToBn(lpAmountBaseUnits),
            seedDepositWad: bigIntToBn(seedDepositWad),
          })
          .accounts({
            config: protocolConfigPda,
            market: marketPda,
            ammState: ammStatePda,
            lpMint,
            lpMintAuthority,
            creatorLpAta,
            lpPosition,
            marketVault: vault,
            creatorUsdcAta: creatorAta,
            usdcMint: USDC_MINT_DEVNET,
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

/** Move the sysvar clock to an absolute unix timestamp, preserving slot and
 *  epoch fields. */
export function warpClockTo(ctx: SvmContext, unixTimestamp: bigint): void {
  const clock = ctx.svm.getClock();
  ctx.setClock(
    new Clock(
      clock.slot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      unixTimestamp,
    ),
  );
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

// Centralized account writer. LiteSVM takes bigint lamports directly, where
// `lamports` is `number` and `rentEpoch` is `number`. The underlying NAPI
// binding actually accepts bigint at runtime — and we want bigint for
// lamport math anyway. Centralize the cast so individual writers stay clean.
function setAcc(
  ctx: SvmContext,
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
    lamports: init.lamports,
    data: init.data,
    rentEpoch: init.rentEpoch ?? 0n,
  });
}

async function fundLamports(
  ctx: SvmContext,
  to: PublicKey,
  lamports: bigint,
): Promise<void> {
  const acc = await ctx.banksClient.getAccount(to);
  const existing = acc ? acc.lamports : 0n;
  setAcc(ctx, to, {
    executable: false,
    owner: SystemProgram.programId,
    lamports: existing + lamports,
    data: acc?.data ?? new Uint8Array(0),
  });
}

async function writeMint(
  ctx: SvmContext,
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
  ctx: SvmContext,
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
  ctx: SvmContext,
  ixs: Array<TransactionInstruction>,
  feePayer: PublicKey,
): Promise<Transaction> {
  const tx = new Transaction();
  // Caller contract for sooth_core's 256 KB allocator — see svm.ts. Without
  // this EVERY sooth_core instruction faults, not just multi-fill buys.
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 }));
  for (const ix of ixs) tx.add(ix);
  const blockhash = await ctx.banksClient.getLatestBlockhash();
  if (!blockhash) throw new Error("no blockhash");
  tx.recentBlockhash = blockhash[0];
  tx.feePayer = feePayer;
  return tx;
}
