// Shared scaffolding for on-chain CLOB tests (bankrun).
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
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  type TransactionInstruction,
  type VersionedTransaction,
} from "@solana/web3.js";
import type { ProgramTestContext } from "solana-bankrun";

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

import { BankrunConnection } from "./bankrun-connection.js";
import type { SmokeContext } from "./setup.js";

// Share amounts are WAD-scaled u128; collateral is 6-decimal USDC.
// BASE_UNIT_WAD (math/book.rs) is the WAD value of one USDC base unit.
export const BASE_UNIT_WAD = 1_000_000_000_000n;

/** A share amount comfortably above min_resting_order_for_tick for any tick
 *  used in these tests, so orders rest instead of being skipped as dust. */
export const SHARES = 1_000n * BASE_UNIT_WAD;

/** Anchor error codes for the CLOB matcher, from sooth_core's error enum.
 *  bankrun surfaces failures as `custom program error: 0x…`, so tests match
 *  on the hex code rather than the name. */
export const CLOB_ERROR = {
  MissingCrossingBookSide: 6051,
  MakerAccountMismatch: 6052,
  WrongBundleArity: 6053,
} as const;

/** Matcher for a specific on-chain error code in a bankrun rejection. */
export function customError(code: number): RegExp {
  return new RegExp(`custom program error: 0x${code.toString(16)}\\b`, "i");
}

export function anchorProgram(
  ctx: ProgramTestContext,
  payer: Keypair,
): Program {
  const conn = new BankrunConnection(ctx);
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
  ctx: ProgramTestContext,
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
      false, // escrow
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
  ctx: ProgramTestContext,
  owner: PublicKey,
  smoke: SmokeContext,
): Promise<bigint> {
  const conn = new BankrunConnection(ctx);
  const ata = deriveUserUsdcAta(owner, smoke.usdcMint);
  const account = await getAccount(conn as any, ata);
  return account.amount;
}

export async function sendTx(
  ctx: ProgramTestContext,
  signers: Keypair[],
  tx: Transaction,
): Promise<void> {
  const blockhash = await ctx.banksClient.getLatestBlockhash();
  if (!blockhash) throw new Error("no blockhash");
  tx.recentBlockhash = blockhash[0];
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  await ctx.banksClient.processTransaction(tx);
}
