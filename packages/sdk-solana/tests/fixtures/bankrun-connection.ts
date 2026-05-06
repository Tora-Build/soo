// Minimal `Connection`-compatible shim over `solana-bankrun`'s `BanksClient`.
// Implements only the methods the SDK + Anchor 0.30.x consume on the buy
// path:
//
//   - getAccountInfo (used by Anchor's `Account.fetchNullable`)
//   - getMultipleAccountsInfo
//   - getLatestBlockhash
//   - sendRawTransaction
//   - confirmTransaction (no-op; bankrun is synchronous in spirit)
//   - getMinimumBalanceForRentExemption
//   - simulateTransaction
//
// Anything else throws clearly so we notice a missing surface immediately.

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

type Wireable = Transaction | VersionedTransaction;

export class BankrunConnection extends Connection {
  private readonly _banks: BanksClient;
  private readonly _ctx: ProgramTestContext;

  constructor(ctx: ProgramTestContext) {
    // The base `Connection` requires a URL — pass localhost to satisfy the
    // constructor; we override every public method we use, so the URL is
    // never dialed.
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

  // Anchor's `Account.fetchNullable` actually calls `getAccountInfoAndContext`.
  // The base `Connection` implementation hits the RPC; we override to forward
  // to the BanksClient instead.
  override async getAccountInfoAndContext(
    publicKey: PublicKey,
    commitment?: Commitment | undefined,
  ): Promise<RpcResponseAndContext<AccountInfo<Buffer> | null>> {
    const value = await this.getAccountInfo(publicKey, commitment);
    return { context: { slot: 0 }, value };
  }

  // Anchor's bulk fetch path uses this. We forward to N independent reads —
  // bankrun doesn't expose a multi-get.
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
    if (!res) throw new Error("BankrunConnection: no blockhash from banks");
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
    // Bankrun doesn't expose a "send raw bytes" — only typed transactions.
    // Decode it back to a `Transaction` (legacy) for processing.
    const tx = Transaction.from(bytes);
    // `processTransaction` waits for completion; throw on failure to mirror
    // `Connection.sendRawTransaction` failing-then-confirm behavior.
    await this._banks.processTransaction(tx);
    return bs58Signature(tx);
  }

  // confirmTransaction is a no-op in bankrun: `processTransaction` already
  // waited. We return a satisfied result.
  override async confirmTransaction(
    _strategy: any,
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

  // For preflight-style checks. Returns logs but no value.
  override async simulateTransaction(
    transaction: Wireable | any,
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
      "BankrunConnection.simulateTransaction only handles legacy Transaction in this shim",
    );
  }
}

// `Connection.sendRawTransaction` returns the signature as a base58 string.
// We extract it from the first signature on the (already-signed) tx. If the
// tx isn't signed yet, return a placeholder — callers in this test rig
// always sign before sending.
function bs58Signature(tx: Transaction): string {
  const sig = tx.signature;
  if (!sig) return "1".repeat(88); // unsigned placeholder
  // Use web3's bs58 utility transitively — `bs58` is a transitive dep.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bs58 = require("bs58");
  // Some bs58 builds export `default`, others the function directly.
  const enc = bs58.default ?? bs58;
  return enc.encode(sig);
}
