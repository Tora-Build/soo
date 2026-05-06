// Local copy of the SDK's `BankrunConnection`. Same reasoning as
// `bootDemo.ts`: the SDK doesn't export `tests/fixtures/*`, and the demo
// can't import from a non-public path without changes there.
//
// If the SDK ever exposes its bankrun helpers as a public dev surface
// (e.g. via a `@sooth/sdk-solana/test-utils` subpath), delete this file.

import type { BanksClient, ProgramTestContext } from "solana-bankrun";
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type AccountInfo,
  type Commitment,
  type RpcResponseAndContext,
  type SignatureResult,
} from "@solana/web3.js";

export class BankrunConnectionShim extends Connection {
  private readonly _banks: BanksClient;
  private readonly _ctx: ProgramTestContext;

  constructor(ctx: ProgramTestContext) {
    super("http://127.0.0.1:8899", "confirmed");
    this._ctx = ctx;
    this._banks = ctx.banksClient;
  }

  get banksClient(): BanksClient {
    return this._banks;
  }

  override async getAccountInfo(
    publicKey: PublicKey,
    _commitment?: Commitment | undefined,
  ): Promise<AccountInfo<Buffer> | null> {
    const acc = await this._banks.getAccount(publicKey);
    if (!acc) return null;
    return {
      executable: acc.executable,
      lamports: Number(acc.lamports),
      owner: new PublicKey(acc.owner),
      rentEpoch: Number(acc.rentEpoch ?? 0),
      data: Buffer.from(acc.data),
    };
  }

  override async getAccountInfoAndContext(
    publicKey: PublicKey,
    commitment?: Commitment | undefined,
  ): Promise<RpcResponseAndContext<AccountInfo<Buffer> | null>> {
    const value = await this.getAccountInfo(publicKey, commitment);
    return { context: { slot: 0 }, value };
  }

  override async getMultipleAccountsInfo(
    publicKeys: PublicKey[],
    _commitment?: Commitment,
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    return Promise.all(publicKeys.map((pk) => this.getAccountInfo(pk)));
  }

  override async getMultipleAccountsInfoAndContext(
    publicKeys: PublicKey[],
    commitment?: Commitment,
  ): Promise<RpcResponseAndContext<(AccountInfo<Buffer> | null)[]>> {
    const value = await this.getMultipleAccountsInfo(publicKeys, commitment);
    return { context: { slot: 0 }, value };
  }

  override async getLatestBlockhash(_commitment?: Commitment): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    const res = await this._banks.getLatestBlockhash();
    if (!res) throw new Error("BankrunConnectionShim: no blockhash from banks");
    return {
      blockhash: res[0],
      lastValidBlockHeight: Number(res[1]),
    };
  }

  override async sendRawTransaction(
    rawTransaction: Buffer | Uint8Array | Array<number>,
  ): Promise<string> {
    const bytes =
      rawTransaction instanceof Uint8Array
        ? rawTransaction
        : Buffer.from(rawTransaction as number[] | Buffer);
    const tx = Transaction.from(bytes);
    await this._banks.processTransaction(tx);
    return bs58Signature(tx);
  }

  override async confirmTransaction(
    _strategy: unknown,
    _commitment?: Commitment,
  ): Promise<RpcResponseAndContext<SignatureResult>> {
    return { context: { slot: 0 }, value: { err: null } };
  }

  override async getMinimumBalanceForRentExemption(
    dataLength: number,
    _commitment?: Commitment,
  ): Promise<number> {
    const rent = await this._banks.getRent();
    return Number(rent.minimumBalance(BigInt(dataLength)));
  }

  // The base `Connection.simulateTransaction` has overloaded signatures that
  // are awkward to reproduce with `override`. We declare a permissive shim
  // (matches the SDK's approach in packages/sdk-solana/tests/fixtures/
  // bankrun-connection.ts) — `any` is fine here because the method is only
  // invoked through the adapter's preflight path, which casts already.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async simulateTransaction(
    transaction: any,
    _signersOrConfig?: any,
  ): Promise<any> {
    if (transaction instanceof Transaction) {
      const meta = await this._banks.simulateTransaction(transaction);
      return {
        context: { slot: 0 },
        value: {
          err: meta.result ?? null,
          logs: meta.meta?.logMessages ?? [],
          unitsConsumed: Number(meta.meta?.computeUnitsConsumed ?? 0),
          accounts: null,
          returnData: null,
        },
      };
    }
    throw new Error(
      "BankrunConnectionShim.simulateTransaction only handles legacy Transaction",
    );
  }
}

function bs58Signature(tx: Transaction): string {
  const sig = tx.signature;
  if (!sig) return "1".repeat(88);
  // bs58 is a transitive dep of @solana/web3.js — reach for it via require so
  // we don't add a direct dependency.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bs58 = require("bs58");
  const enc = bs58.default ?? bs58;
  return enc.encode(sig);
}
