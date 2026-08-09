// End-to-end test for `sooth_core::create_market` — the one-shot
// market-creation ix that creates Market PDA, vaults,
// and AmmState in a single transaction.
//
// Flow:
//   1. Boot LiteSVM with `sooth_core` loaded at its `declare_id!` address.
//   2. Hand-write the canonical USDC mint at `USDC_MINT_DEVNET`.
//   3. Initialize the singleton `ProtocolConfig` PDA.
//   4. Build a `create_market` request via `adapter.buildCreateMarket(...)`
//      and submit it.
//   5. Assert: market PDA, vault, lock_vault, and
//      amm_state PDAs all exist with expected field values.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AnchorProvider,
  BN,
  Program,
  type Idl,
  type Wallet,
} from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, MintLayout } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";
import { Clock, startSvm, type SvmContext } from "./fixtures/svm.js";

import { soothCoreIdl } from "../src/anchor/index.js";
import {
  deriveAdjudicatorEntryPda,
  deriveAmmStatePda,
  deriveLockAuthorityPda,
  deriveLockVaultAta,
  deriveMarketPda,
  deriveMarketVaultAta,
  deriveProtocolConfigPda,
  deriveVaultAuthorityPda,
  SOOTH_CORE_PROGRAM_ID,
  type ProgramIds,
} from "../src/pdas.js";
import { WAD } from "../src/math/lmsr.js";
import { SolanaChainAdapter } from "../src/adapter.js";
import { encodePubkeyRef } from "../src/refs.js";

import { LiteSvmConnection } from "./fixtures/svm.js";
import { resolveDeployDir } from "./fixtures/setup.js";

const SOOTH_CORE_ID = new PublicKey(soothCoreIdl.address) ?? SOOTH_CORE_PROGRAM_ID;
const USDC_MINT_DEVNET = new PublicKey(
  "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX",
);

const PROGRAMS: ProgramIds = {
  soothCore: SOOTH_CORE_ID,
};

describe("sooth_core::create_market end-to-end", () => {
  it("creates Market + vaults + AmmState in one tx", async () => {
    // ─── 0. Boot LiteSVM with sooth_core ──────────────────────────────────
    const soDir = resolveDeployDir();
    process.env.BPF_OUT_DIR = soDir;
    try {
      readFileSync(resolve(soDir, "sooth_core.so"));
    } catch {
      throw new Error(
        `create-market test: missing sooth_core.so in ${soDir}. Run \`cargo build-sbf\` first.`,
      );
    }
    const ctx = startSvm(
      [{ name: "sooth_core", programId: SOOTH_CORE_ID }],
      soDir,
    );

    // ─── 1. USDC mint ─────────────────────────────────────────────────────
    const mintAuthority = Keypair.generate();
    await writeMint(ctx, USDC_MINT_DEVNET, mintAuthority.publicKey);

    // ─── 2. Funded creator ────────────────────────────────────────────────
    const creator = Keypair.generate();
    await fundLamports(ctx, creator.publicKey, 50n * BigInt(LAMPORTS_PER_SOL));

    // LiteSVM boots at unix_timestamp = 0; advance to a sane "now" so
    // `compute_trial_end_at` doesn't trivially short-circuit. 1_000_000s
    // is the same baseline the smoke test uses.
    const now = 1_000_000;
    const existingClock = await ctx.banksClient.getClock();
    ctx.setClock(
      new Clock(
        existingClock.slot,
        existingClock.epochStartTimestamp,
        existingClock.epoch,
        existingClock.leaderScheduleEpoch,
        BigInt(now),
      ),
    );

    // ─── 3. Anchor handles ────────────────────────────────────────────────
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

    // ─── 4. Initialize the singleton ProtocolConfig ───────────────────────
    const [configPda] = deriveProtocolConfigPda(PROGRAMS);
    await sendTx(
      ctx,
      [creator],
      await buildTx(
        ctx,
        [
          await (coreProgram.methods as any)
            .initializeProtocol({
              ammFeeBps: 500, // 5%
              bookFeeBps: 100, // 1%
              treasury: creator.publicKey,
              bBaseShareBps: 5_000,
              lpYieldShareBps: 3_000,
              adjudicatorShareBps: 1_000,
              protocolShareBps: 1_000,
              defaultTrialPeriod: new BN(7 * 24 * 60 * 60),
              permissionlessAdjudicators: true,
              vetoPeriodSecs: new BN(24 * 60 * 60),
            })
            .accounts({
              config: configPda,
              authority: creator.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .instruction(),
        ],
        creator.publicKey,
      ),
    );

    // ─── 5. Build + submit create_market via the SDK adapter ──────────────
    const adapter = new SolanaChainAdapter({
      node: {
        id: "create-market-test",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: PROGRAMS,
      usdcMint: USDC_MINT_DEVNET,
      connection: conn,
    });

    const marketId = new Uint8Array(16);
    for (let i = 0; i < 16; i++) marketId[i] = (i * 17) & 0xff;
    const deadline = BigInt(now + 7 * 24 * 60 * 60);
    const initialB = 1_000n * WAD;

    const req = await adapter.buildCreateMarket({
      question: "Will Solana hit $500 before EOY 2026?",
      deadline,
      marketId,
      startTime: BigInt(now + 60),
      adjudicator: encodePubkeyRef(creator.publicKey),
      initialB,
      user: encodePubkeyRef(creator.publicKey),
    });

    expect(req.kind).toBe("createMarket");
    expect(req.accounts).toBeDefined();
    expect(req.accounts!.length).toBeGreaterThan(10);

    // ─── Reconstruct + sign + send the ix from the request meta ──────────
    const meta = req.meta as {
      ixData: string;
      ixKeys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
      ixProgramId: string;
    };
    const ix = {
      programId: new PublicKey(meta.ixProgramId),
      keys: meta.ixKeys.map((k) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(meta.ixData, "base64"),
    };
    await sendTx(ctx, [creator], await buildTx(ctx, [ix], creator.publicKey));

    // ─── 6. Assert all PDAs exist with right field values ─────────────────
    const [marketPda] = deriveMarketPda(marketId, PROGRAMS);
    const [vaultAuthority] = deriveVaultAuthorityPda(marketId, PROGRAMS);
    const [lockAuthority] = deriveLockAuthorityPda(marketId, PROGRAMS);
    const vault = deriveMarketVaultAta(marketId, USDC_MINT_DEVNET, PROGRAMS);
    const lockVault = deriveLockVaultAta(marketId, USDC_MINT_DEVNET, PROGRAMS);
    const [ammStatePda] = deriveAmmStatePda(marketId, PROGRAMS);

    const marketAcc = await ctx.banksClient.getAccount(marketPda);
    expect(marketAcc).toBeTruthy();
    expect(marketAcc!.owner.toBase58()).toBe(SOOTH_CORE_ID.toBase58());

    const vaultAcc = await ctx.banksClient.getAccount(vault);
    expect(vaultAcc).toBeTruthy();
    expect(vaultAcc!.owner.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());

    const lockVaultAcc = await ctx.banksClient.getAccount(lockVault);
    expect(lockVaultAcc).toBeTruthy();
    expect(lockVaultAcc!.owner.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());

    const ammAcc = await ctx.banksClient.getAccount(ammStatePda);
    expect(ammAcc).toBeTruthy();
    expect(ammAcc!.owner.toBase58()).toBe(SOOTH_CORE_ID.toBase58());

    // Decode AmmState to verify the args round-tripped.
    const ammState = await (coreProgram.account as any).ammState.fetch(ammStatePda);
    expect(ammState.market.toBase58()).toBe(marketPda.toBase58());
    expect(ammState.b.toString()).toBe(initialB.toString());
    expect(ammState.qYes.toString()).toBe("0");
    expect(ammState.qNo.toString()).toBe("0");
    expect(ammState.isGraduated).toBe(false);
    // `trial_end_at = now + min(0.3 × (deadline - now), default_trial_period)`.
    // Here deadline-now = 7 days (604_800s), default_trial_period = 7 days,
    // so trial_duration = min(181_440, 604_800) = 181_440 → trial_end_at =
    // now + 181_440 = 1_181_440. The exact value is sensitive to chain-time
    // sampling at handler entry; loose-bound by ±60s to absorb that.
    const expectedTrialEnd = now + (7 * 24 * 60 * 60 * 3) / 10;
    const trialEndAt = Number(ammState.trialEndAt.toString());
    expect(Math.abs(trialEndAt - expectedTrialEnd)).toBeLessThanOrEqual(60);

    // Decode Market to verify lifecycle = Open and the vaults are populated.
    const marketState = await (coreProgram.account as any).market.fetch(marketPda);
    expect(marketState.creator.toBase58()).toBe(creator.publicKey.toBase58());
    expect(marketState.adjudicator.toBase58()).toBe(
      creator.publicKey.toBase58(),
    );
    expect(marketState.vault.toBase58()).toBe(vault.toBase58());
    expect(marketState.lockVault.toBase58()).toBe(lockVault.toBase58());
    expect(Object.keys(marketState.lifecycle)[0]).toBe("open");

    // Sanity: the vault_authority + lock_authority PDAs are signer-only;
    // they don't have data accounts. Just confirm the bumps stored on the
    // Market match the seeds we computed off-chain.
    expect(typeof marketState.vaultAuthorityBump).toBe("number");
    expect(typeof marketState.lockAuthorityBump).toBe("number");
    // Bumps stored on Market come from `find_program_address` inside
    // `create_market`; we re-derive here via the same seeds.
    const [, expectedVaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(marketId)],
      SOOTH_CORE_ID,
    );
    const [, expectedLockBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("lock"), Buffer.from(marketId)],
      SOOTH_CORE_ID,
    );
    expect(marketState.vaultAuthorityBump).toBe(expectedVaultBump);
    expect(marketState.lockAuthorityBump).toBe(expectedLockBump);

    // ─── 7. register_adjudicator ─────────────────────────────────────────
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
              protocolConfig: configPda,
              signer: creator.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .instruction(),
        ],
        creator.publicKey,
      ),
    );
    const adjEntryAcc = await ctx.banksClient.getAccount(adjudicatorEntryPda);
    expect(adjEntryAcc).toBeTruthy();
    expect(adjEntryAcc!.owner.toBase58()).toBe(SOOTH_CORE_ID.toBase58());

    // Silence unused-var for vaultAuthority/lockAuthority/mintAuthority.
    void vaultAuthority;
    void lockAuthority;
    void mintAuthority;
  });
});

// ─── Internals (mirrored from fixtures/setup.ts) ───────────────────────────

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

async function buildTx(
  ctx: SvmContext,
  ixs: Array<import("@solana/web3.js").TransactionInstruction>,
  feePayer: PublicKey,
): Promise<Transaction> {
  const tx = new Transaction();
  // Caller contract for sooth_core's 256 KB allocator — see fixtures/svm.ts.
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 }));
  for (const ix of ixs) tx.add(ix);
  const blockhash = await ctx.banksClient.getLatestBlockhash();
  if (!blockhash) throw new Error("no blockhash");
  tx.recentBlockhash = blockhash[0];
  tx.feePayer = feePayer;
  return tx;
}
