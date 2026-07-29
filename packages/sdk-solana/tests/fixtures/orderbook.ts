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
  createAssociatedTokenAccountInstruction,
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
  bookSidePda,
  deriveFeePoolAuthorityPda,
  deriveMarketVaultAta,
  deriveProtocolConfigPda,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  marketBookPda,
  marketFeePoolPda,
  orderbookPositionPda,
} from "../../src/pdas.js";

import { LiteSvmConnection } from "./svm.js";
import type { SmokeContext } from "./setup.js";

// Share amounts are WAD-scaled u128; collateral is 6-decimal USDC.
// BASE_UNIT_WAD (math/book.rs) is the WAD value of one USDC base unit.
export const BASE_UNIT_WAD = 1_000_000_000_000n;

/** A share amount comfortably above min_resting_order_for_tick for any tick
 *  used in these tests, so orders rest instead of being skipped as dust. */
export const SHARES = 1_000n * BASE_UNIT_WAD;

/** Anchor error codes for the CLOB matcher, from sooth_core's error enum.
 *  the SVM surfaces failures as `custom program error: 0x…`, so tests match
 *  on the hex code rather than the name. */
export const CLOB_ERROR = {
  MissingCrossingBookSide: 6051,
  MakerAccountMismatch: 6052,
  WrongBundleArity: 6053,
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
  const { ctx, creator, user, usdcMint } = smoke;
  const maker = Keypair.generate();

  const acc = await ctx.banksClient.getAccount(maker.publicKey);
  ctx.setAccount(maker.publicKey, {
    executable: false,
    owner: SystemProgram.programId,
    lamports: (5n * BigInt(LAMPORTS_PER_SOL)) as unknown as number,
    data: acc?.data ?? new Uint8Array(0),
    rentEpoch: 0n as unknown as number,
  });

  const makerAta = deriveUserUsdcAta(maker.publicKey, usdcMint);
  await sendTx(
    ctx,
    [creator],
    new Transaction().add(
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        makerAta,
        maker.publicKey,
        usdcMint,
      ),
    ),
  );
  await sendTx(
    ctx,
    [user],
    new Transaction().add(
      createTransferInstruction(
        deriveUserUsdcAta(user.publicKey, usdcMint),
        makerAta,
        user.publicKey,
        usdcBaseUnits,
      ),
    ),
  );
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
  const [marketFeePool] = marketFeePoolPda(smoke.marketId, smoke.programs);
  await sendTx(
    ctx,
    [payer],
    new Transaction().add(
      await (program.methods as any)
        .initMarketFeePool()
        .accounts({
          market: smoke.marketPda,
          feePoolAuthority,
          usdcMint: smoke.usdcMint,
          marketFeePool,
          signer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction(),
    ),
  );
}

export interface BuyArgs {
  signer: Keypair;
  side: number;
  tick: number;
  amount: bigint;
  matchLimit: number;
  /** Flat list of fill-bundle accounts, FILL_BUNDLE_LEN per predicted fill,
   *  ordered exactly as the matcher will consume them. */
  remaining: PublicKey[];
  /** Escrowed orders settle in shares the wallet already holds rather than
   *  collateral. Defaults to false. */
  escrow?: boolean;
}

export async function buyTx(
  program: Program,
  smoke: SmokeContext,
  args: BuyArgs,
): Promise<Transaction> {
  const { marketId, programs, usdcMint, marketPda } = smoke;
  const [marketBook] = marketBookPda(marketId, programs);
  const [bookSide] = bookSidePda(
    marketId,
    args.side as 0 | 1,
    args.tick,
    programs,
  );
  const [vaultAuthority] = deriveVaultAuthorityPda(marketId, programs);
  const [marketFeePool] = marketFeePoolPda(marketId, programs);
  const [protocolConfig] = deriveProtocolConfigPda(programs);
  const [takerOrderbookPosition] = orderbookPositionPda(
    marketId,
    args.signer.publicKey,
    programs,
  );

  const ix: TransactionInstruction = await (program.methods as any)
    .buy(
      args.side,
      args.tick,
      new BN(args.amount.toString()),
      args.escrow ?? false,
      args.matchLimit,
    )
    .accounts({
      taker: args.signer.publicKey,
      market: marketPda,
      marketBook,
      bookSide,
      marketUsdcVault: deriveMarketVaultAta(marketId, usdcMint, programs),
      vaultAuthority,
      marketFeePool,
      takerUsdcAta: deriveUserUsdcAta(args.signer.publicKey, usdcMint),
      takerOrderbookPosition,
      protocolConfig,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .remainingAccounts(
      args.remaining.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      })),
    )
    .instruction();

  return new Transaction().add(ix);
}

/** Engage or release the protocol circuit-breaker. `authority` must be the
 *  ProtocolConfig authority (bootSmoke sets this to `creator`). */
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

/** Cancel every resting order the user holds at (side, tick), refunding
 *  collateral. An exit path — deliberately NOT gated by the pause flag. */
export async function cancelTx(
  program: Program,
  smoke: SmokeContext,
  user: Keypair,
  side: number,
  tick: number,
): Promise<Transaction> {
  const { marketId, programs, usdcMint, marketPda } = smoke;
  const [marketBook] = marketBookPda(marketId, programs);
  const [bookSide] = bookSidePda(marketId, side as 0 | 1, tick, programs);
  const [vaultAuthority] = deriveVaultAuthorityPda(marketId, programs);
  const [userOrderbookPosition] = orderbookPositionPda(
    marketId,
    user.publicKey,
    programs,
  );
  return new Transaction().add(
    await (program.methods as any)
      .cancel(side, tick)
      .accounts({
        user: user.publicKey,
        market: marketPda,
        marketBook,
        bookSide,
        vaultAuthority,
        marketUsdcVault: deriveMarketVaultAta(marketId, usdcMint, programs),
        userUsdcAta: deriveUserUsdcAta(user.publicKey, usdcMint),
        userOrderbookPosition,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction(),
  );
}

/** One fill bundle: [book_side, maker_position, maker_usdc_ata]. */
export function fillBundle(
  smoke: SmokeContext,
  side: number,
  tick: number,
  maker: PublicKey,
): PublicKey[] {
  const [bookSide] = bookSidePda(
    smoke.marketId,
    side as 0 | 1,
    tick,
    smoke.programs,
  );
  const [position] = orderbookPositionPda(
    smoke.marketId,
    maker,
    smoke.programs,
  );
  return [bookSide, position, deriveUserUsdcAta(maker, smoke.usdcMint)];
}

export async function fetchPosition(
  program: Program,
  address: PublicKey,
): Promise<any> {
  return (program.account as any).orderbookPosition.fetch(address);
}

export async function fetchBookSide(
  program: Program,
  address: PublicKey,
): Promise<any> {
  return (program.account as any).bookSide.fetch(address);
}

/** Total amount still resting at or after head_index. */
export function liveAmount(bookSide: {
  headIndex: number;
  orders: Array<{ amount: BN }>;
}): bigint {
  return bookSide.orders
    .slice(bookSide.headIndex)
    .reduce((sum, o) => sum + BigInt(o.amount.toString()), 0n);
}

export async function usdcBalance(
  ctx: SvmContext,
  owner: PublicKey,
  smoke: SmokeContext,
): Promise<bigint> {
  const conn = new LiteSvmConnection(ctx);
  const ata = deriveUserUsdcAta(owner, smoke.usdcMint);
  const account = await getAccount(conn as any, ata);
  return account.amount;
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

/** Per-transaction CU cap for raw test transactions. Solana's default is
 *  200k per instruction, which a 4-fill buy already brushes against — the
 *  real budget is 1.4M, so raise it explicitly rather than measuring against
 *  an artificial ceiling. Mirrors what the SDK adapter and main's
 *  cu_measurement.rs both do. */
/** Must equal SOOTH_CORE_HEAP_LEN in the program's lib.rs. */
export const SOOTH_CORE_HEAP_BYTES = 256 * 1024;

export const TEST_CU_LIMIT = 1_400_000;

/** Maximum wire size of a Solana transaction (PACKET_DATA_SIZE). */
export const MAX_TX_BYTES = 1232;

/** Prepend the compute-budget preamble every sooth_core transaction needs:
 *  the 256 KB heap frame (mandatory — see heapFrameIx) and a realistic CU
 *  cap. */
export function withHeapFrame(tx: Transaction): Transaction {
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

export interface TxCost {
  /** Compute units the transaction actually consumed. */
  computeUnits: number;
  /** Wire size of the signed transaction. A real cluster rejects anything
   *  over 1232 bytes (PACKET_DATA_SIZE); LiteSVM does not enforce this, so
   *  tests must check it explicitly or they will validate transactions that
   *  could never be submitted. */
  serializedBytes: number;
  /** Distinct writable accounts in the compiled message. This is the budget
   *  that caps fills per transaction (~3.7), not compute — see
   *  docs/spec/sooth_book.md §13 Q2. */
  writableAccounts: number;
}

/** Send and report what it cost. Throws with program logs on failure, same as
 *  sendTx, so a measured transaction can never silently record a failed run. */
export async function sendTxMeasured(
  ctx: SvmContext,
  signers: Keypair[],
  tx: Transaction,
  opts: SendOpts = {},
): Promise<TxCost> {
  const sending = opts.skipHeapFrame ? tx : withHeapFrame(tx);
  const blockhash = await ctx.banksClient.getLatestBlockhash();
  if (!blockhash) throw new Error("no blockhash");
  sending.recentBlockhash = blockhash[0];
  sending.feePayer = signers[0]!.publicKey;
  sending.sign(...signers);

  const writableAccounts = countWritableAccounts(sending);
  const res = await ctx.banksClient.tryProcessTransaction(sending);
  if (res.result !== null) {
    const logs = (res.meta?.logMessages ?? []).join("\n");
    throw new Error(`measured tx failed: ${res.result}\n${logs}`);
  }
  return {
    computeUnits: Number(res.meta?.computeUnitsConsumed ?? 0),
    serializedBytes: sending.serialize({ verifySignatures: false }).length,
    writableAccounts,
  };
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

/** Credit `amountBaseUnits` of BOTH outcomes to the user's OrderbookPosition
 *  by depositing collateral. Escrowed resting orders settle against these
 *  shares, so a maker must hold them before resting with `escrow: true`. */
export async function mintCompleteSetForOrderbook(
  ctx: SvmContext,
  program: Program,
  smoke: SmokeContext,
  user: Keypair,
  amountBaseUnits: bigint,
): Promise<void> {
  const { marketId, programs, usdcMint, marketPda } = smoke;
  const [position] = orderbookPositionPda(marketId, user.publicKey, programs);
  await sendTx(
    ctx,
    [user],
    new Transaction().add(
      await (program.methods as any)
        .mintCompleteSetForOrderbook(new BN(amountBaseUnits.toString()))
        .accounts({
          market: marketPda,
          position,
          vault: deriveMarketVaultAta(marketId, usdcMint, programs),
          userUsdcAta: deriveUserUsdcAta(user.publicKey, usdcMint),
          user: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction(),
    ),
  );
}
