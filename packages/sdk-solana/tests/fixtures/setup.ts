// Shared smoke-test setup. Boots bankrun with both Sooth programs deployed
// at their `declare_id!` placeholder addresses, prepares a USDC mint, and
// pre-funds a test user. Drives the real on-chain init instructions end-to-
// end (Market → outcome mints → vaults → AmmState) — no `setAccount`
// shortcuts.
//
// Why placeholder addresses, not the deploy keypairs:
//   `declare_id!("SoothAMM…")` in `programs/sooth_amm/src/lib.rs` bakes the
//   placeholder into the .so binary. Anchor's runtime checks
//   `program_id == crate::ID`, so the program must execute at its declared
//   ID. The deploy keypairs in `target/deploy/*.json` are not actually used
//   by the binaries — they would only matter for `anchor deploy`.
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

import {
  soothAdjudicatorIdl,
  soothAmmIdl,
  soothLaunchpadIdl,
  soothMarketIdl,
} from "../../src/anchor/index.js";
import {
  deriveAmmStatePda,
  deriveFeePoolAuthorityPda,
  deriveFeePoolVaultAta,
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
  SOOTH_MARKET_PROGRAM_ID,
  type ProgramIds,
} from "../../src/pdas.js";
import { WAD } from "../../src/math/lmsr.js";
import { BankrunConnection } from "./bankrun-connection.js";

// Workspace root, derived from this file's location.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

// Placeholder program IDs (from `declare_id!` in the on-chain programs).
export const SOOTH_AMM_ID = new PublicKey(soothAmmIdl.address);
export const SOOTH_MARKET_ID =
  soothMarketIdl.address && soothMarketIdl.address.length > 0
    ? new PublicKey(soothMarketIdl.address)
    : SOOTH_MARKET_PROGRAM_ID;
export const SOOTH_LAUNCHPAD_ID = new PublicKey(soothLaunchpadIdl.address);
export const SOOTH_ADJUDICATOR_ID = new PublicKey(soothAdjudicatorIdl.address);

const INIT_MARKET_FEE_POOL_DISCRIMINATOR = Buffer.from([
  51, 19, 251, 120, 171, 91, 138, 115,
]);

export const PROGRAMS: ProgramIds = {
  soothAmm: SOOTH_AMM_ID,
  soothMarket: SOOTH_MARKET_ID,
  soothLaunchpad: SOOTH_LAUNCHPAD_ID,
  soothAdjudicator: SOOTH_ADJUDICATOR_ID,
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

// Boot bankrun with both programs + the SPL token program. Returns a context
// pre-loaded with:
//   - a USDC mint owned by `payer`
//   - a funded test `user` Keypair with USDC ATA
//   - a `Market` PDA created via `sooth_market::initialize_market`
//   - outcome mints + vault + lock_vault created via the follow-up legs
//   - an `AmmState` PDA created via `sooth_amm::initialize_amm_state`
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
  // Sanity-check that the .so files exist; fail fast with a clear message
  // if they don't (means `cargo build-sbf` hasn't been run for this commit).
  // sooth_launchpad is loaded too — Wave 5A's `trade_positions` /
  // `sell_positions` validate the singleton `protocol_config` PDA and
  // global `fee_pool_vault` ATA, both owned by the launchpad. The bootstrap
  // sequence below initialises both before any AMM trade can land.
  for (const so of ["sooth_amm.so", "sooth_market.so", "sooth_launchpad.so"]) {
    try {
      readFileSync(resolve(soDir, so));
    } catch {
      throw new Error(
        `smoke test: missing ${so} in ${soDir}. Run \`cargo build-sbf\` from the workspace root or anchor build in packages/programs-core first.`,
      );
    }
  }

  const ctx = await start(
    [
      { name: "sooth_amm", programId: SOOTH_AMM_ID },
      { name: "sooth_market", programId: SOOTH_MARKET_ID },
      { name: "sooth_launchpad", programId: SOOTH_LAUNCHPAD_ID },
    ],
    [],
    /* computeMaxUnits */ 1_400_000n,
  );

  // ─── Mint a fresh USDC at the canonical devnet address ────────────────
  // We can't use the real devnet USDC mint because `initialize_market` and
  // `trade_positions` constrain `usdc_mint` against `USDC_MINT_DEVNET`
  // (`programs/sooth_amm/src/lib.rs`). We hand-write the mint *at that
  // address* using setAccount — bankrun lets us populate the canonical
  // address with our own mint authority. This is a fixture, not a bypass.
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

  // ─── Build Anchor `Program` handles bound to bankrun ────────────────────
  // Anchor needs a Provider; the BankrunConnection forwards getAccountInfo /
  // sendRawTransaction / etc. to bankrun's BanksClient. We use the `creator`
  // as the Provider wallet so `program.methods.…rpc()` signs+sends through
  // the bankrun client.
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
  const marketProgram = new Program(
    { ...soothMarketIdl, address: SOOTH_MARKET_ID.toBase58() } as Idl,
    provider,
  );
  const ammProgram = new Program(soothAmmIdl as Idl, provider);
  const launchpadProgram = new Program(soothLaunchpadIdl as Idl, provider);

  // ─── 0. adjudicator allowlist bootstrap ─────────────────────────────────
  //
  // Codex C2 minimum-viable mitigation: `initialize_market` now requires the
  // adjudicator pubkey to (a) not be the default key and (b) be present on a
  // singleton on-chain allowlist. We seed the allowlist via the real ixs
  // (`initialize_adjudicator_allowlist` + `add_adjudicator`) rather than
  // setAccount-ing the bytes — the seed flow is the same one the localnet
  // demo uses, so smoke tests double as integration coverage of those ixs.
  // The creator wallet plays both the allowlist authority AND the
  // adjudicator role for the duration of the smoke run.
  const [allowlistPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("adjudicator_allowlist")],
    SOOTH_MARKET_ID,
  );
  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (marketProgram.methods as any)
          .initializeAdjudicatorAllowlist(creator.publicKey)
          .accounts({
            allowlist: allowlistPda,
            signer: creator.publicKey,
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
        await (marketProgram.methods as any)
          .addAdjudicator(creator.publicKey)
          .accounts({
            allowlist: allowlistPda,
            authority: creator.publicKey,
          })
          .instruction(),
      ],
      creator.publicKey,
    ),
  );

  // ─── 0b. launchpad bootstrap: ProtocolConfig + global fee_pool_vault ────
  //
  // Wave 5A made `sooth_amm::trade_positions` and `sell_positions` read the
  // singleton `protocol_config` PDA + global `fee_pool_vault` USDC ATA on
  // every buy/sell. Both live under `sooth_launchpad`. The two ixs below
  // are single-shot per cluster — calling them twice trips
  // `account already in use` from the runtime — but each `bootSmoke()` call
  // boots a fresh bankrun ctx so the singletons are always fresh here.
  const [protocolConfigPda] = deriveProtocolConfigPda({
    soothLaunchpad: SOOTH_LAUNCHPAD_ID,
  });
  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (launchpadProgram.methods as any)
          .initializeProtocol({
            feeBps: 100, // 1%
            treasury: creator.publicKey, // demo: creator doubles as treasury
            bBaseShareBps: 5_000,
            lpYieldShareBps: 3_000,
            adjudicatorShareBps: 1_000,
            protocolShareBps: 1_000,
            defaultTrialPeriod: new BN(7 * 24 * 60 * 60),
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

  const [feePoolAuthorityPda] = deriveFeePoolAuthorityPda({
    soothLaunchpad: SOOTH_LAUNCHPAD_ID,
  });
  const feePoolVault = deriveFeePoolVaultAta(USDC_MINT_DEVNET, {
    soothLaunchpad: SOOTH_LAUNCHPAD_ID,
  });
  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (launchpadProgram.methods as any)
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
          .instruction(),
      ],
      creator.publicKey,
    ),
  );

  // ─── 1. initialize_market (Market PDA only) ─────────────────────────────
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
        await (marketProgram.methods as any)
          .initializeMarket({
            marketId: Array.from(marketId),
            questionHash: Array(32).fill(0),
            startTime: new BN(startTime),
            deadline: new BN(deadline),
            adjudicator: creator.publicKey,
          })
          .accounts({
            market: marketPda,
            adjudicatorAllowlist: allowlistPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ],
      creator.publicKey,
    ),
  );

  // ─── 2. initialize_outcome_mints ────────────────────────────────────────
  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (marketProgram.methods as any)
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

  // ─── 3. initialize_market_vaults ────────────────────────────────────────
  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (marketProgram.methods as any)
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

  // ─── 3b. init_market_fee_pool ──────────────────────────────────────────
  //
  // Current AMM buy/sell instructions route fees into a per-market
  // sooth_launchpad token account. The tracked launchpad IDL can lag this
  // helper, so fixture setup sends the zero-arg instruction by discriminator.
  const [marketFeePool] = marketFeePoolPda(marketId, PROGRAMS);
  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        new TransactionInstruction({
          programId: SOOTH_LAUNCHPAD_ID,
          keys: [
            { pubkey: marketPda, isSigner: false, isWritable: false },
            {
              pubkey: feePoolAuthorityPda,
              isSigner: false,
              isWritable: false,
            },
            { pubkey: USDC_MINT_DEVNET, isSigner: false, isWritable: false },
            { pubkey: marketFeePool, isSigner: false, isWritable: true },
            { pubkey: creator.publicKey, isSigner: true, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            {
              pubkey: SystemProgram.programId,
              isSigner: false,
              isWritable: false,
            },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          ],
          data: Buffer.from(INIT_MARKET_FEE_POOL_DISCRIMINATOR),
        }),
      ],
      creator.publicKey,
    ),
  );

  // ─── Advance bankrun's clock past `startTime` ──────────────────────────
  // C1 (Codex) added a `start_time <= now < deadline` guard to
  // `trade_positions`. Bankrun boots with `unix_timestamp = 0`; warp the
  // sysvar clock to a slot inside the trading window so the buy path can
  // execute. We pick `startTime + 1` as the smallest legal value — keeps
  // the gap to `deadline` maximal. The other fields on `Clock` are read by
  // very few programs; preserving their defaults is fine.
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

  // ─── 4. initialize_amm_state ────────────────────────────────────────────
  const [ammStatePda] = deriveAmmStatePda(marketId, PROGRAMS);
  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (ammProgram.methods as any)
          .initializeAmmState({
            initialB: bigIntToBn(bWad),
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

  // ─── 5. seed_lp — bootstrap per-market LP mint + creator allocation ────
  //
  // Architecture §4.2: every pre-graduation buy mints LP units to the
  // trader via `sooth_amm::trade_positions` → CPI → `sooth_launchpad::
  // mint_lp_for_buy`. That CPI requires the per-market `lp_mint` PDA to
  // already exist as an SPL Mint. Bootstrap it here so trade smoke tests
  // (and the demo amm-buy-flow) exercise the LP-mint-on-buy side-effect.
  //
  // `lp_amount` mirrors the seed deposit in USDC base units (the
  // architecture-§4.2 "1:1 with deposit" rule applied at bootstrap).
  // `bWad` is the LMSR liquidity in WAD; convert to USDC base units by
  // dividing by 1e12 (WAD/USDC scale ratio — same as `wadToUsdcCeil`
  // would yield for a clean multiple).
  const [lpMint] = deriveLpMintPda(marketId, {
    soothLaunchpad: SOOTH_LAUNCHPAD_ID,
  });
  const [lpMintAuthority] = deriveLpMintAuthorityPda(marketId, {
    soothLaunchpad: SOOTH_LAUNCHPAD_ID,
  });
  const [lpPosition] = deriveLpPositionPda(marketId, creator.publicKey, {
    soothLaunchpad: SOOTH_LAUNCHPAD_ID,
  });
  const creatorLpAta = deriveUserLpAta(creator.publicKey, lpMint);
  const lpAmountBaseUnits = bWad / 1_000_000_000_000n;
  await sendTx(
    ctx,
    [creator],
    await buildTx(
      ctx,
      [
        await (launchpadProgram.methods as any)
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
      ["sooth_amm.so", "sooth_market.so", "sooth_launchpad.so"].every((so) =>
        existsSync(resolve(candidate, so)),
      ),
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
  // Existing balance comes back as `number` per AccountInfo<Uint8Array>.
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
  // Rent-exempt minimum for the mint's data length.
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

// Assemble a Transaction from a list of instructions. Sets the latest
// blockhash + fee payer; the caller signs+submits via `sendTx`.
async function buildTx(
  ctx: ProgramTestContext,
  ixs: Array<import("@solana/web3.js").TransactionInstruction>,
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
