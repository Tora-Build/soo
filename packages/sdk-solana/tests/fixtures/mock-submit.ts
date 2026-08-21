// A `Connection` that answers `submit()` without a chain, and keeps the bytes.
//
// `submit` is where the adapter assembles a transaction — compute budget,
// pre-instructions, the sooth_core instruction, blockhash — so assertions
// about what a transaction CARRIES have to read the serialized message it
// sends. This captures that message instead of broadcasting it.
//
// It is not a chain: no account exists, nothing executes, and confirmation is
// always success. Anything that depends on program state belongs on the
// LiteSVM fixtures instead.

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  type Commitment,
  type RpcResponseAndContext,
  type SignatureResult,
  type SignatureStatus,
} from "@solana/web3.js";

import { soothCoreIdl } from "../../src/anchor/index.js";
import { SolanaChainAdapter } from "../../src/adapter.js";
import { SOOTH_CORE_PROGRAM_ID, type ProgramIds } from "../../src/pdas.js";

/** The fixture's mock USDC — the mint both venue roles resolve to here. */
export const MOCK_USDC = new PublicKey(
  "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX",
);

export type PriorityFeeSample = {
  slot: number;
  prioritizationFee: number;
};

export class CapturingConnection extends Connection {
  feeCalls = 0;
  feeConfigs: Array<{ lockedWritableAccounts?: PublicKey[] } | undefined> = [];
  rawTransactions: Uint8Array[] = [];
  private readonly blockhash = Keypair.generate().publicKey.toBase58();

  constructor(
    private readonly opts: {
      fees?: PriorityFeeSample[];
      feeError?: Error;
    } = {},
  ) {
    super("http://127.0.0.1:8899", "confirmed");
  }

  override async getRecentPrioritizationFees(config?: {
    lockedWritableAccounts?: PublicKey[];
  }): Promise<PriorityFeeSample[]> {
    this.feeCalls += 1;
    this.feeConfigs.push(config);
    if (this.opts.feeError) throw this.opts.feeError;
    return this.opts.fees ?? [];
  }

  override async getLatestBlockhash(_c?: Commitment): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    return { blockhash: this.blockhash, lastValidBlockHeight: 999 };
  }

  override async sendRawTransaction(
    rawTransaction: Buffer | Uint8Array | Array<number>,
  ): Promise<string> {
    const bytes =
      rawTransaction instanceof Uint8Array
        ? rawTransaction
        : new Uint8Array(rawTransaction as ArrayLike<number>);
    this.rawTransactions.push(bytes);
    return `sig-${this.rawTransactions.length}`;
  }

  override async confirmTransaction(
    _strategy: unknown,
    _commitment?: Commitment,
  ): Promise<RpcResponseAndContext<SignatureResult>> {
    return { context: { slot: 0 }, value: { err: null } };
  }

  // The adapter confirms by polling getSignatureStatus over HTTP; without
  // this override it would fall through to the real Connection and fetch.
  override async getSignatureStatus(
    _signature: string,
  ): Promise<RpcResponseAndContext<SignatureStatus | null>> {
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
}

/**
 * An adapter over `connection`, plus the smallest `SoothRequest` `submit()`
 * accepts and a signer that returns the message unchanged.
 *
 * The instruction carries no real discriminator — nothing executes it. What it
 * pins is the assembly around it.
 */
export function mockSubmitAdapter(connection: Connection) {
  const programs: ProgramIds = {
    soothCore: new PublicKey(soothCoreIdl.address) ?? SOOTH_CORE_PROGRAM_ID,
  };
  const user = Keypair.generate();
  const marketPda = Keypair.generate().publicKey;
  const adapter = new SolanaChainAdapter({
    node: {
      id: "mock-submit",
      chainKind: "solana",
      chainId: "test",
      rpcUrl: "http://localhost:8899",
    },
    programIds: programs,
    // Both venue roles, one mock mint — as the deployment itself is.
    bookMint: MOCK_USDC,
    ammMint: MOCK_USDC,
    connection,
  });
  const ix = new TransactionInstruction({
    programId: programs.soothCore,
    keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }],
    data: Buffer.alloc(8),
  });
  const req = {
    kind: "trade" as const,
    serializedTx: undefined,
    costEstimateWad: 0n,
    accounts: [],
    meta: {
      marketPda: marketPda.toBase58(),
      userPk: user.publicKey.toBase58(),
      ixData: Buffer.from(ix.data).toString("base64"),
      ixKeys: ix.keys.map((k) => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      ixProgramId: ix.programId.toBase58(),
    },
  };
  const signer = {
    publicKey: user.publicKey.toBase58(),
    signTransaction: async (raw: Uint8Array): Promise<Uint8Array> => raw,
  };
  return { adapter, req, signer, marketPda, programs };
}
