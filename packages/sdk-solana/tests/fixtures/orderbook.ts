// Shared scaffolding for on-chain CLOB tests (LiteSVM).
//
// bootSmoke() leaves off where the orderbook begins: it creates the market and
// seeds the AMM, but `buy` additionally needs a live `market_fee_pool` (which
// create_market does not create) and a second funded wallet to act as maker.
// Both live here so the crossing tests stay about matching behaviour.

import {
  AnchorProvider,
  BN,
  Program,
  type Idl,
  type Wallet,
} from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAccount,
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
import type { SvmContext } from "./svm.js";

import { soothCoreIdl } from "../../src/anchor/index.js";
import {
  deriveFeePoolAuthorityPda,
  deriveMarketVaultAta,
  deriveProtocolConfigPda,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  feePoolAmmPda,
  lpYieldAmmPda,
  lpYieldBookPda,
  deriveLpYieldAuthority,
  feePoolBookPda,
} from "../../src/pdas.js";

import { LiteSvmConnection } from "./svm.js";
import type { SmokeContext } from "./setup.js";

// Share amounts are WAD-scaled u128; collateral is 6-decimal USDC.
// BASE_UNIT_WAD (math/book.rs) is the WAD value of one USDC base unit.
const BASE_UNIT_WAD = 1_000_000_000_000n;

/** A share amount comfortably above min_resting_order_for_tick for any tick
 *  used in these tests, so orders rest instead of being skipped as dust. */
export const SHARES = 1_000n * BASE_UNIT_WAD;

/** Anchor error codes this fixture asserts on. The SVM surfaces failures as
 *  `custom program error: 0x…`, so tests match the hex code, not the name.
 *  Ordinals are positional from 6000 — see `sooth_core`'s `error.rs`. */
export const CLOB_ERROR = {
  ProtocolPaused: 6054,
} as const;

/** Matcher for a specific on-chain error code in a LiteSVM rejection. */
export function customError(code: number): RegExp {
  return new RegExp(`custom program error: 0x${code.toString(16)}\\b`, "i");
}

export function anchorProgram(
  ctx: SvmContext,
  payer: Keypair,
): Program {
  const conn = new LiteSvmConnection(ctx);
  const wallet: Wallet = {
    publicKey: payer.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(
      tx: T,
    ): Promise<T> => {
      (tx as Transaction).partialSign(payer);
      return tx;
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(
      txs: T[],
    ): Promise<T[]> => {
      for (const tx of txs) (tx as Transaction).partialSign(payer);
      return txs;
    },
    payer,
  };
  const provider = new AnchorProvider(conn, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return new Program(soothCoreIdl as Idl, provider);
}

/** A funded wallet to act as maker. USDC comes from the smoke user by SPL
 *  transfer, because bootSmoke keeps the mint authority private. */
export async function createFundedMaker(
  smoke: SmokeContext,
  usdcBaseUnits: bigint,
): Promise<Keypair> {
  const { ctx, creator, user, usdcMint, ammMint } = smoke;
  const maker = Keypair.generate();

  const acc = await ctx.banksClient.getAccount(maker.publicKey);
  ctx.setAccount(maker.publicKey, {
    executable: false,
    owner: SystemProgram.programId,
    lamports: (5n * BigInt(LAMPORTS_PER_SOL)) as unknown as number,
    data: acc?.data ?? new Uint8Array(0),
    rentEpoch: 0n as unknown as number,
  });

  // Funded in BOTH venue roles. With one mint filling both roles the
  // idempotent create is a no-op the second time and the amounts accumulate;
  // with two mints it funds the second balance. Either way the maker can
  // quote the book AND touch the AMM, so tests fail on what they assert,
  // not on balance.
  for (const mint of [usdcMint, ammMint]) {
    const makerAta = deriveUserUsdcAta(maker.publicKey, mint);
    await sendTx(
      ctx,
      [creator],
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          creator.publicKey,
          makerAta,
          maker.publicKey,
          mint,
        ),
      ),
    );
    await sendTx(
      ctx,
      [user],
      new Transaction().add(
        createTransferInstruction(
          deriveUserUsdcAta(user.publicKey, mint),
          makerAta,
          user.publicKey,
          usdcBaseUnits,
        ),
      ),
    );
  }
  return maker;
}

/** `buy` requires a live market_fee_pool; create_market does not create one. */
export async function initMarketFeePool(
  ctx: SvmContext,
  program: Program,
  smoke: SmokeContext,
  payer: Keypair,
): Promise<void> {
  const [feePoolAuthority] = deriveFeePoolAuthorityPda(smoke.programs);
  // One instruction, both pools — an SPL token account holds one mint, so the
  // venues cannot share one.
  const [feePoolBook] = feePoolBookPda(smoke.marketId, smoke.programs);
  const [feePoolAmm] = feePoolAmmPda(smoke.marketId, smoke.programs);
  const [lpYieldAuthority] = deriveLpYieldAuthority(smoke.programs);
  const [lpYieldAmm] = lpYieldAmmPda(smoke.marketId, smoke.programs);
  const [lpYieldBook] = lpYieldBookPda(smoke.marketId, smoke.programs);
  await sendTx(
    ctx,
    [payer],
    new Transaction().add(
      await (program.methods as any)
        .initMarketFeePool()
        .accounts({
          market: smoke.marketPda,
          feePoolAuthority,
          bookMint: smoke.usdcMint,
          ammMint: smoke.ammMint,
          feePoolBook,
          feePoolAmm,
          lpYieldAuthority,
          lpYieldAmm,
          lpYieldBook,
          signer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction(),
    ),
  );
}


/** Engage or release the protocol circuit-breaker. `authority` must be the
 *  ProtocolConfig authority (bootSmoke sets this to `creator`). */
/**
 * Open the book without driving a real graduation.
 *
 * `book_place` requires `Market.book_enabled`, which the program sets only when
 * graduation fires in `trade_positions` — thousands of USDC of AMM volume. The
 * book tests are about the book, so they flip the bit directly rather than
 * paying for an incubation they are not testing.
 *
 * Decoded and re-encoded through Anchor's coder rather than poked at a byte
 * offset. The offset version was correct when written and silently wrong two
 * commits later, when a new field shifted the layout — it wrote into
 * `lock_authority_bump` instead, and every book test failed with
 * `NotGraduated` for a reason that had nothing to do with the gate.
 *
 * `graduation-gate.test.ts` covers the real transition, so nothing here is
 * asserting against a state the program cannot reach.
 */
export async function enableBook(
  ctx: SvmContext,
  smoke: SmokeContext,
): Promise<void> {
  const raw = await ctx.banksClient.getAccount(smoke.marketPda);
  if (!raw) throw new Error("enableBook: market account not found");
  const program = anchorProgram(ctx, smoke.creator);
  const coder = (program as unknown as { coder: any }).coder;
  const market = coder.accounts.decode("market", Buffer.from(raw.data));
  market.bookEnabled = true;
  const encoded: Buffer = await coder.accounts.encode("market", market);
  const data = Buffer.from(raw.data);
  encoded.copy(data, 0);
  ctx.setAccount(smoke.marketPda, {
    executable: false,
    owner: raw.owner,
    lamports: raw.lamports,
    data,
  });
}

export async function setPaused(
  ctx: SvmContext,
  program: Program,
  smoke: SmokeContext,
  authority: Keypair,
  paused: boolean,
): Promise<void> {
  const [config] = deriveProtocolConfigPda(smoke.programs);
  const method = paused ? "pause" : "unpause";
  await sendTx(
    ctx,
    [authority],
    new Transaction().add(
      await (program.methods as any)
        [method]()
        .accounts({ config, authority: authority.publicKey })
        .instruction(),
    ),
  );
}

/** sooth_core installs a 256 KB #[global_allocator]; the runtime only maps it
 *  when the transaction requests the frame. Every raw-instruction path must
 *  prepend this, exactly as the SDK adapter does — omitting it faults with
 *  "Access violation in heap section". */
export function heapFrameIx(): TransactionInstruction {
  return ComputeBudgetProgram.requestHeapFrame({
    bytes: SOOTH_CORE_HEAP_BYTES,
  });
}

/** Must equal SOOTH_CORE_HEAP_LEN in the program's lib.rs. */
export const SOOTH_CORE_HEAP_BYTES = 256 * 1024;

/** Solana's per-instruction default is 200k; the real per-transaction budget
 *  is 1.4M. Raise it so a measurement is against the real ceiling. */
const TEST_CU_LIMIT = 1_400_000;

/** Prepend the compute-budget preamble every sooth_core transaction needs:
 *  the 256 KB heap frame (mandatory — see heapFrameIx) and a realistic CU
 *  cap. */
function withHeapFrame(tx: Transaction): Transaction {
  const framed = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: TEST_CU_LIMIT }))
    .add(heapFrameIx());
  for (const ix of tx.instructions) framed.add(ix);
  return framed;
}

export interface SendOpts {
  /** Send WITHOUT the heap frame. Only for the test that deliberately proves
   *  the caller contract is load-bearing. */
  skipHeapFrame?: boolean;
}

export async function sendTx(
  ctx: SvmContext,
  signers: Keypair[],
  tx: Transaction,
  opts: SendOpts = {},
): Promise<void> {
  const sending = opts.skipHeapFrame ? tx : withHeapFrame(tx);
  const blockhash = await ctx.banksClient.getLatestBlockhash();
  if (!blockhash) throw new Error("no blockhash");
  sending.recentBlockhash = blockhash[0];
  sending.feePayer = signers[0]!.publicKey;
  sending.sign(...signers);
  await ctx.banksClient.processTransaction(sending);
}

/** Writable-account count from the compiled message header. Solana marks an
 *  account writable by position: signers come first (the trailing
 *  `numReadonlySignedAccounts` of them are read-only), then non-signers (the
 *  trailing `numReadonlyUnsignedAccounts` of those are read-only). */
export function countWritableAccounts(tx: Transaction): number {
  const msg = tx.compileMessage();
  const total = msg.accountKeys.length;
  const { numRequiredSignatures, numReadonlySignedAccounts } = msg.header;
  const { numReadonlyUnsignedAccounts } = msg.header;
  const writableSigners = numRequiredSignatures - numReadonlySignedAccounts;
  const writableNonSigners =
    total - numRequiredSignatures - numReadonlyUnsignedAccounts;
  return writableSigners + writableNonSigners;
}
