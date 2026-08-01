// LiteSVM engine for the on-chain tests.
//
// WHY NOT BANKRUN: sooth_core ships a 256 KB custom #[global_allocator]
// (lib.rs), which the runtime only maps when a transaction sends
// `requestHeapFrame`. LiteSVM wraps solana-program-test, which does not
// implement that instruction — its `start()` exposes computeMaxUnits and
// transactionAccountLockLimit and nothing for the heap. Under LiteSVM every
// sooth_core instruction therefore faults with
//
//     Access violation in heap section at address 0x30003ff68
//
// i.e. the harness could only ever test a BUILD THAT IS NOT THE ONE WE
// DEPLOY. LiteSVM honours the heap frame (verified both ways: with the frame
// the program runs, without it the access violation reproduces exactly), so
// `custom-heap` stays on by default and the tested artifact is the shipped
// artifact.
//
// This module presents the same surface LiteSVM's ProgramTestContext did, so
// the fixtures above it are engine-agnostic — swapping engines again later
// means reimplementing this file, not rewriting the tests.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type AccountInfo,
  type Commitment,
  type GetBlockHeightConfig,
  type RpcResponseAndContext,
  type SignatureResult,
  type SignatureStatus,
} from "@solana/web3.js";
import { Clock, LiteSVM } from "litesvm";

export { Clock };

/** Account shape the fixtures read, mirroring LiteSVM's. */
export interface SvmAccount {
  executable: boolean;
  owner: PublicKey;
  lamports: bigint;
  data: Uint8Array;
  rentEpoch: bigint;
}

export interface SvmInnerInstruction {
  /** Index of the top-level instruction this is a child of. */
  index: number;
  programIdIndex: number;
  data: Uint8Array;
}

export interface SvmTxMeta {
  logMessages: string[];
  computeUnitsConsumed: bigint;
  /** Inner (CPI) instructions, which is where durable events live — see the
   *  self-CPI event payloads. Empty if the runtime did not record any. */
  innerInstructions: SvmInnerInstruction[];
}

/** Result shape mirroring LiteSVM's tryProcessTransaction. */
export interface SvmTxResult {
  result: string | null;
  meta: SvmTxMeta | null;
}

/** LiteSVM's transaction type is @solana/kit's `{ messageBytes, signatures }`.
 *  Everything upstream builds web3.js Transactions, so convert at the edge
 *  rather than porting the fixtures to a second SDK. */
function toKitTransaction(tx: Transaction): any {
  const messageBytes = new Uint8Array(tx.serializeMessage());
  const signatures: Record<string, Uint8Array | null> = {};
  for (const sig of tx.signatures) {
    signatures[sig.publicKey.toBase58()] = sig.signature
      ? new Uint8Array(sig.signature)
      : null;
  }
  return { messageBytes, signatures };
}

function readMeta(res: any): SvmTxMeta | null {
  try {
    const meta = typeof res.meta === "function" ? res.meta() : res;
    // innerInstructions() is Array<Array<InnerInstruction>>, outer index =
    // the top-level instruction the children belong to. That index is what a
    // consumer needs to prove an event came from the right parent.
    const inner: SvmInnerInstruction[] = [];
    try {
      const groups = meta.innerInstructions?.() ?? [];
      groups.forEach((group: any[], index: number) => {
        for (const entry of group ?? []) {
          const compiled = entry.instruction();
          inner.push({
            index,
            programIdIndex: compiled.programIdIndex(),
            data: compiled.data(),
          });
        }
      });
    } catch {
      /* runtime did not record inner instructions */
    }
    return {
      logMessages: meta.logs?.() ?? [],
      computeUnitsConsumed: meta.computeUnitsConsumed?.() ?? 0n,
      innerInstructions: inner,
    };
  } catch {
    return null;
  }
}

/** Did this result represent a failure? LiteSVM returns a
 *  FailedTransactionMetadata (which carries `err()`) rather than throwing.
 *
 *  The message is reshaped into the form LiteSVM produced —
 *  `Error processing Instruction N: custom program error: 0x…` — because both
 *  the SDK's error classifier and the tests' `customError()` matcher parse
 *  that string. LiteSVM's own `err()` renders as
 *  `TransactionErrorInstructionError { index: 1, error: InstructionErrorCustom
 *  { code: 6054 } }`, which carries the same information in a different
 *  shape; the program logs still contain the canonical
 *  `Program <id> failed: <reason>` line, so we lift the reason from there and
 *  the instruction index from the structured error. */
function readError(res: any): string | null {
  let structured: string | null = null;
  try {
    if (typeof res.err === "function") {
      const err = res.err();
      if (err) structured = String(err.toString?.() ?? err);
    }
  } catch {
    /* TransactionMetadata has no err() — success */
  }
  if (structured === null) return null;

  const logs: string[] = readMeta(res)?.logMessages ?? [];
  const failed = [...logs]
    .reverse()
    .map((line) => /Program \S+ failed: (.+)$/.exec(line)?.[1])
    .find((reason): reason is string => Boolean(reason));
  if (!failed) return structured;

  const index = /index: (\d+)/.exec(structured)?.[1] ?? "0";
  return `Error processing Instruction ${index}: ${failed}`;
}

/** LiteSVM-shaped client over LiteSVM. */
export class SvmClient {
  constructor(private readonly svm: LiteSVM) {}

  async getAccount(address: PublicKey): Promise<SvmAccount | null> {
    const acc: any = this.svm.getAccount(address.toBase58() as any);
    if (!acc || acc.exists === false) return null;
    return {
      executable: acc.executable,
      owner: new PublicKey(acc.programAddress),
      lamports: BigInt(acc.lamports),
      data: acc.data,
      rentEpoch: 0n,
    };
  }

  async getLatestBlockhash(): Promise<[string, bigint] | null> {
    return [this.svm.latestBlockhash(), 1_000n];
  }

  async getRent(): Promise<{ minimumBalance: (space: bigint) => bigint }> {
    return {
      minimumBalance: (space: bigint) =>
        this.svm.minimumBalanceForRentExemption(space),
    };
  }

  async getClock(): Promise<Clock> {
    return this.svm.getClock();
  }

  /** Throws on failure, with program logs attached — same contract LiteSVM
   *  had, so the SDK's log-scanning error classifier still sees real logs. */
  async processTransaction(tx: Transaction): Promise<void> {
    const res: any = this.svm.sendTransaction(toKitTransaction(tx));
    this.advance();
    const err = readError(res);
    if (err !== null) {
      const meta = readMeta(res);
      const e = new Error(err) as Error & { logs?: string[] };
      e.logs = meta?.logMessages ?? [];
      throw e;
    }
  }

  async tryProcessTransaction(tx: Transaction): Promise<SvmTxResult> {
    const res: any = this.svm.sendTransaction(toKitTransaction(tx));
    const out = { result: readError(res), meta: readMeta(res) };
    this.advance();
    return out;
  }

  /** Roll the blockhash after every send, so each transaction lands in its
   *  own block as it would on a real cluster. Without this, re-sending an
   *  identical instruction (e.g. the same order rejected while paused, then
   *  retried after unpause) reuses the blockhash, produces an identical
   *  signature, and is rejected from the status cache as already-processed. */
  private advance(): void {
    this.svm.expireBlockhash();
  }

  simulate(tx: Transaction): {
    logs: string[];
    err: string | null;
    unitsConsumed: number;
  } {
    const res: any = this.svm.simulateTransaction(toKitTransaction(tx));
    const meta = readMeta(res);
    return {
      logs: meta?.logMessages ?? [],
      err: readError(res),
      unitsConsumed: Number(meta?.computeUnitsConsumed ?? 0n),
    };
  }
}

/** ProgramTestContext-shaped container. */
export class SvmContext {
  readonly banksClient: SvmClient;

  constructor(readonly svm: LiteSVM) {
    this.banksClient = new SvmClient(svm);
  }

  setAccount(
    address: PublicKey,
    init: {
      executable: boolean;
      owner: PublicKey;
      lamports: bigint | number;
      data: Uint8Array;
      rentEpoch?: bigint | number;
    },
  ): void {
    this.svm.setAccount({
      address: address.toBase58(),
      exists: true,
      executable: init.executable,
      lamports: BigInt(init.lamports),
      programAddress: init.owner.toBase58(),
      space: BigInt(init.data.length),
      data: init.data,
    } as any);
  }

  setClock(clock: Clock): void {
    this.svm.setClock(clock);
  }

  warpToSlot(slot: bigint): void {
    this.svm.warpToSlot(slot);
  }
}

/** Boot a LiteSVM with the given programs deployed at their declared IDs. */
export function startSvm(
  programs: Array<{ name: string; programId: PublicKey }>,
  deployDir: string,
): SvmContext {
  const svm = new LiteSVM();
  for (const { name, programId } of programs) {
    const path = resolve(deployDir, `${name}.so`);
    try {
      readFileSync(path);
    } catch {
      throw new Error(
        `missing ${path}. Run \`anchor build\` from the workspace root first.`,
      );
    }
    svm.addProgramFromFile(programId.toBase58() as any, path);
  }
  return new SvmContext(svm);
}

/**
 * `Connection`-compatible shim so Anchor's `Program` can build and send
 * against LiteSVM. Only the methods the SDK and Anchor 0.30.x touch are
 * implemented; anything else falls through to the base class, which would
 * dial the (never-listening) localhost URL and fail loudly.
 */
export class LiteSvmConnection extends Connection {
  private _simSigners: Keypair[] = [];

  constructor(private readonly ctx: SvmContext) {
    super("http://127.0.0.1:8899", "confirmed");
  }

  get svmContext(): SvmContext {
    return this.ctx;
  }

  setSimSigners(signers: Keypair[]): void {
    this._simSigners = signers;
  }

  override async getAccountInfo(
    publicKey: PublicKey,
  ): Promise<AccountInfo<Buffer> | null> {
    const acc = await this.ctx.banksClient.getAccount(publicKey);
    if (!acc) return null;
    return {
      executable: acc.executable,
      lamports: Number(acc.lamports),
      owner: acc.owner,
      rentEpoch: Number(acc.rentEpoch),
      data: Buffer.from(acc.data),
    };
  }

  override async getAccountInfoAndContext(
    publicKey: PublicKey,
  ): Promise<RpcResponseAndContext<AccountInfo<Buffer> | null>> {
    return { context: { slot: 0 }, value: await this.getAccountInfo(publicKey) };
  }

  override async getMultipleAccountsInfo(
    publicKeys: PublicKey[],
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    return Promise.all(publicKeys.map((pk) => this.getAccountInfo(pk)));
  }

  override async getMultipleAccountsInfoAndContext(
    publicKeys: PublicKey[],
  ): Promise<RpcResponseAndContext<(AccountInfo<Buffer> | null)[]>> {
    return {
      context: { slot: 0 },
      value: await this.getMultipleAccountsInfo(publicKeys),
    };
  }

  override async getLatestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    const res = await this.ctx.banksClient.getLatestBlockhash();
    if (!res) throw new Error("LiteSvmConnection: no blockhash");
    return { blockhash: res[0], lastValidBlockHeight: Number(res[1]) };
  }

  override async sendRawTransaction(
    rawTransaction: Buffer | Uint8Array | Array<number>,
  ): Promise<string> {
    const bytes =
      rawTransaction instanceof Uint8Array
        ? rawTransaction
        : Buffer.from(rawTransaction as number[] | Buffer);
    const tx = Transaction.from(bytes);
    // Mirrors LiteSVM's contract: throw with `.logs` attached so the SDK's
    // failing-program-ID extractor has real logs to scan.
    await this.ctx.banksClient.processTransaction(tx);
    return bs58Signature(tx);
  }

  override async confirmTransaction(): Promise<
    RpcResponseAndContext<SignatureResult>
  > {
    return { context: { slot: 0 }, value: { err: null } };
  }

  // The adapter confirms by polling this over HTTP. sendRawTransaction has
  // already executed the transaction (and thrown on failure), so anything we
  // are asked about has landed.
  override async getSignatureStatus(): Promise<
    RpcResponseAndContext<SignatureStatus | null>
  > {
    return {
      context: { slot: 0 },
      value: {
        slot: 0,
        confirmations: 0,
        err: null,
        confirmationStatus: "confirmed",
      },
    };
  }

  // Declared as a property on Connection, so the override must be one too.
  override getBlockHeight = async (
    _commitmentOrConfig?: Commitment | GetBlockHeightConfig,
  ): Promise<number> => 0;

  override async getMinimumBalanceForRentExemption(
    dataLength: number,
  ): Promise<number> {
    const rent = await this.ctx.banksClient.getRent();
    return Number(rent.minimumBalance(BigInt(dataLength)));
  }

  override async simulateTransaction(
    transaction: Transaction | VersionedTransaction | any,
  ): Promise<any> {
    if (transaction instanceof Transaction) {
      const tx = transaction;
      if (!tx.recentBlockhash) {
        tx.recentBlockhash = (await this.getLatestBlockhash()).blockhash;
      }
      // LiteSVM verifies signatures even on simulation, while real RPC
      // defaults to sigVerify=false for unsigned legacy txs. Partial-sign
      // with any registered sim-signer the message references, matching
      // real-RPC semantics for adapter.preflight().
      const keys = new Set(
        tx.compileMessage().accountKeys.map((k) => k.toBase58()),
      );
      const signers = this._simSigners.filter((s) =>
        keys.has(s.publicKey.toBase58()),
      );
      if (signers.length > 0) tx.partialSign(...signers);
      const { logs, err, unitsConsumed } = this.ctx.banksClient.simulate(tx);
      return { context: { slot: 0 }, value: { err, logs, unitsConsumed } };
    }
    return { context: { slot: 0 }, value: { err: null, logs: [] } };
  }
}

function bs58Signature(tx: Transaction): string {
  const sig = tx.signature;
  if (!sig) return "1".repeat(88);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bs58 = require("bs58");
  const enc = bs58.default ?? bs58;
  return enc.encode(sig);
}
