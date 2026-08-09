// Fixture for the redesigned orderbook (docs/design/orderbook-redesign.md).
//
// Instructions are hand-encoded rather than driven through Anchor's client
// because the book account is loaded by raw cast and has no `#[account]` type
// for Anchor to resolve. That is deliberate on-chain; here it just means we
// write the discriminators ourselves.

import {
  AccountLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  deriveMarketVaultAta,
  deriveProtocolConfigPda,
  deriveVaultAuthorityPda,
  feePoolBookPda,
} from "../../src/pdas.js";
import { SOOTH_CORE_ID, type SmokeContext } from "./setup.js";
import { countWritableAccounts, heapFrameIx } from "./orderbook.js";

export const SIDE_BID = 0; // buy YES
export const SIDE_ASK = 1; // sell YES  ==  buy NO at (1 - p)
export const ONE_SHARE = 1_000_000n; // USDC base units; redeems for 1.00

/** sha256("global:<ix>")[..8] */
const DISC = {
  init: Buffer.from([71, 248, 196, 177, 97, 141, 21, 244]),
  grow: Buffer.from([243, 106, 1, 169, 190, 123, 193, 203]),
  place: Buffer.from([166, 211, 8, 100, 130, 30, 212, 203]),
  cancel: Buffer.from([188, 129, 42, 161, 150, 10, 3, 59]),
  withdraw: Buffer.from([138, 127, 40, 44, 99, 47, 107, 106]),
};

export function bookPda(marketId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("book"), Buffer.from(marketId)],
    SOOTH_CORE_ID,
  )[0];
}

const key = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({
  pubkey,
  isSigner,
  isWritable,
});

/** Anchor `#[event_cpi]` tail: authority PDA + the program itself. */
const eventCpiKeys = () => [
  key(
    PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      SOOTH_CORE_ID,
    )[0],
    false,
  ),
  key(SOOTH_CORE_ID, false),
];

export function bookInitIx(smoke: SmokeContext, payer: PublicKey, capacity: number) {
  const d = Buffer.alloc(10);
  DISC.init.copy(d, 0);
  d.writeUInt16LE(capacity, 8);
  return new TransactionInstruction({
    programId: SOOTH_CORE_ID,
    keys: [
      key(bookPda(smoke.marketId), true),
      key(smoke.marketPda, false),
      key(payer, true, true),
      key(SystemProgram.programId, false),
    ],
    data: d,
  });
}

export function bookGrowIx(smoke: SmokeContext, payer: PublicKey, capacity: number) {
  const d = Buffer.alloc(10);
  DISC.grow.copy(d, 0);
  d.writeUInt16LE(capacity, 8);
  return new TransactionInstruction({
    programId: SOOTH_CORE_ID,
    keys: [
      key(bookPda(smoke.marketId), true),
      key(smoke.marketPda, false),
      key(payer, true, true),
      key(SystemProgram.programId, false),
    ],
    data: d,
  });
}

export function bookPlaceIx(
  smoke: SmokeContext,
  taker: PublicKey,
  side: number,
  tick: number,
  amount: bigint,
  matchLimit: number,
  postRemainder: boolean,
) {
  const d = Buffer.alloc(8 + 1 + 2 + 8 + 4 + 1);
  DISC.place.copy(d, 0);
  let o = 8;
  d.writeUInt8(side, o);
  o += 1;
  d.writeUInt16LE(tick, o);
  o += 2;
  d.writeBigUInt64LE(amount, o);
  o += 8;
  d.writeUInt32LE(matchLimit, o);
  o += 4;
  d.writeUInt8(postRemainder ? 1 : 0, o);

  const { marketId, programs, usdcMint } = smoke;
  return new TransactionInstruction({
    programId: SOOTH_CORE_ID,
    keys: [
      key(bookPda(marketId), true),
      key(smoke.marketPda, false),
      key(deriveVaultAuthorityPda(marketId, programs)[0], false),
      key(deriveMarketVaultAta(marketId, usdcMint, programs), true),
      key(getAssociatedTokenAddressSync(usdcMint, taker), true),
      key(feePoolBookPda(marketId, programs)[0], true),
      key(deriveProtocolConfigPda(programs)[0], false),
      key(taker, false, true),
      key(TOKEN_PROGRAM_ID, false),
      ...eventCpiKeys(),
    ],
    data: d,
  });
}

export function bookCancelIx(smoke: SmokeContext, owner: PublicKey, seq: bigint) {
  const d = Buffer.alloc(16);
  DISC.cancel.copy(d, 0);
  d.writeBigUInt64LE(seq, 8);
  return new TransactionInstruction({
    programId: SOOTH_CORE_ID,
    keys: [
      key(bookPda(smoke.marketId), true),
      key(smoke.marketPda, false),
      key(owner, false, true),
      ...eventCpiKeys(),
    ],
    data: d,
  });
}

export function bookWithdrawIx(smoke: SmokeContext, user: PublicKey) {
  const { marketId, programs, usdcMint } = smoke;
  return new TransactionInstruction({
    programId: SOOTH_CORE_ID,
    keys: [
      key(bookPda(marketId), true),
      key(smoke.marketPda, false),
      key(deriveVaultAuthorityPda(marketId, programs)[0], false),
      key(deriveMarketVaultAta(marketId, usdcMint, programs), true),
      key(getAssociatedTokenAddressSync(usdcMint, user), true),
      key(user, false, true),
      key(TOKEN_PROGRAM_ID, false),
    ],
    data: DISC.withdraw,
  });
}

export interface Sent {
  cu: number;
  bytes: number;
  writable: number;
  accounts: number;
  logs: string[];
  /** Raw transaction meta — inner instructions live here. */
  meta: any;
  /** Compiled account keys, for resolving `programIdIndex`. */
  accountKeys: PublicKey[];
}

export async function sendBookTx(
  smoke: SmokeContext,
  signer: Keypair,
  ...ixs: TransactionInstruction[]
): Promise<Sent> {
  return sendBookTxRaw(smoke, signer, {}, ...ixs);
}

/**
 * `sendBookTx` with the preamble under the caller's control.
 *
 * `skipHeapFrame` exists for one test: proving the frame is genuinely required.
 * Nothing else should use it.
 */
export async function sendBookTxRaw(
  smoke: SmokeContext,
  signer: Keypair,
  opts: { skipHeapFrame?: boolean },
  ...ixs: TransactionInstruction[]
): Promise<Sent> {
  // The 256 KB heap frame is mandatory even though the book path allocates
  // little: the custom #[global_allocator] is program-wide, and the allocator
  // hands out addresses from the TOP of a region the runtime only maps when
  // asked, so the first allocation faults without it.
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  );
  if (!opts.skipHeapFrame) tx.add(heapFrameIx());
  for (const ix of ixs) tx.add(ix);

  const bh = await smoke.ctx.banksClient.getLatestBlockhash();
  tx.recentBlockhash = bh![0];
  tx.feePayer = signer.publicKey;
  tx.sign(signer);

  const res = await smoke.ctx.banksClient.tryProcessTransaction(tx);
  if (res.result !== null) {
    const logs = (res.meta?.logMessages ?? []).join("\n");
    throw new Error(`${res.result}\n${logs}`);
  }
  smoke.ctx.expireBlockhash?.();
  const msg = tx.compileMessage();
  return {
    cu: Number(res.meta?.computeUnitsConsumed ?? 0),
    bytes: tx.serialize({ verifySignatures: false }).length,
    writable: countWritableAccounts(tx),
    accounts: msg.accountKeys.length,
    logs: res.meta?.logMessages ?? [],
    meta: res.meta,
    accountKeys: msg.accountKeys,
  };
}

/** A funded trader: SOL plus a USDC ATA holding `usdc` base units. */
export async function trader(
  smoke: SmokeContext,
  usdc = 1_000_000_000n,
): Promise<Keypair> {
  const kp = Keypair.generate();
  smoke.ctx.setAccount(kp.publicKey, {
    executable: false,
    owner: SystemProgram.programId,
    lamports: 100 * LAMPORTS_PER_SOL,
    data: Buffer.alloc(0),
  });
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: smoke.usdcMint,
      owner: kp.publicKey,
      amount: usdc,
      delegateOption: 0,
      delegate: PublicKey.default,
      delegatedAmount: 0n,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  smoke.ctx.setAccount(
    getAssociatedTokenAddressSync(smoke.usdcMint, kp.publicKey),
    {
      executable: false,
      owner: new PublicKey(TOKEN_PROGRAM_ID),
      lamports: 10 * LAMPORTS_PER_SOL,
      data,
    },
  );
  return kp;
}

export async function usdcOf(
  smoke: SmokeContext,
  who: PublicKey,
): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(smoke.usdcMint, who);
  const acct = await smoke.ctx.banksClient.getAccount(ata);
  return AccountLayout.decode(Buffer.from(acct!.data)).amount;
}

/** Header fields, read straight out of the account bytes. */
export async function bookHeader(smoke: SmokeContext) {
  const acct = await smoke.ctx.banksClient.getAccount(bookPda(smoke.marketId));
  const d = Buffer.from(acct!.data);
  return {
    len: d.length,
    nextSeq: d.readBigUInt64LE(8 + 32),
    freeHead: d.readUInt32LE(8 + 40),
    bidsHead: d.readUInt32LE(8 + 44),
    asksHead: d.readUInt32LE(8 + 48),
    blockCount: d.readUInt32LE(8 + 52),
    orderCount: d.readUInt32LE(8 + 56),
    seatsHead: d.readUInt32LE(8 + 60),
  };
}
