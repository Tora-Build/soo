import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Commitment,
  type RpcResponseAndContext,
  type SignatureResult,
} from "@solana/web3.js";

import { soothAmmIdl, soothMarketIdl } from "../src/anchor/index.js";
import { SolanaChainAdapter } from "../src/adapter.js";
import type { ProgramIds } from "../src/pdas.js";

type PriorityFeeSample = {
  slot: number;
  prioritizationFee: number;
};

class PriorityFeeConnection extends Connection {
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
}

function makeAdapter(connection: Connection) {
  const programs: ProgramIds = {
    soothAmm: new PublicKey(soothAmmIdl.address),
    soothMarket: new PublicKey(soothMarketIdl.address),
  };
  const user = Keypair.generate();
  const marketPda = Keypair.generate().publicKey;
  const adapter = new SolanaChainAdapter({
    node: {
      id: "priority-fee-test",
      chainKind: "solana",
      chainId: "test",
      rpcUrl: "http://localhost:8899",
    },
    programIds: programs,
    usdcMint: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
    connection,
  });
  const req = buildMockRequest(programs, user.publicKey, marketPda);
  const signer = {
    publicKey: user.publicKey.toBase58(),
    signTransaction: async (raw: Uint8Array): Promise<Uint8Array> => raw,
  };
  return { adapter, req, signer, marketPda };
}

function buildMockRequest(
  programs: ProgramIds,
  userPk: PublicKey,
  marketPda: PublicKey,
) {
  const ix = new TransactionInstruction({
    programId: programs.soothAmm,
    keys: [{ pubkey: userPk, isSigner: true, isWritable: true }],
    data: Buffer.alloc(8),
  });
  return {
    kind: "trade" as const,
    serializedTx: undefined,
    costEstimateWad: 0n,
    accounts: [],
    meta: {
      marketPda: marketPda.toBase58(),
      userPk: userPk.toBase58(),
      ixData: Buffer.from(ix.data).toString("base64"),
      ixKeys: ix.keys.map((k) => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      ixProgramId: ix.programId.toBase58(),
    },
  };
}

function computeUnitPriceMicroLamports(raw: Uint8Array): number {
  const tx = Transaction.from(Buffer.from(raw));
  const ix = tx.instructions.find(
    (candidate) =>
      candidate.programId.equals(ComputeBudgetProgram.programId) &&
      candidate.data[0] === 3,
  );
  if (!ix) throw new Error("missing setComputeUnitPrice instruction");
  return Number(Buffer.from(ix.data).readBigUInt64LE(1));
}

describe("submit priority fee", () => {
  it("uses a bounded recent-fee value and keeps identical submits distinct", async () => {
    const conn = new PriorityFeeConnection({
      fees: [
        { slot: 1, prioritizationFee: 10 },
        { slot: 2, prioritizationFee: 200 },
        { slot: 3, prioritizationFee: 300 },
      ],
    });
    const { adapter, req, signer, marketPda } = makeAdapter(conn);

    await adapter.submit(req as any, signer);
    await adapter.submit(req as any, signer);

    const firstPrice = computeUnitPriceMicroLamports(conn.rawTransactions[0]!);
    const secondPrice = computeUnitPriceMicroLamports(conn.rawTransactions[1]!);
    expect(firstPrice).toBeGreaterThanOrEqual(1);
    expect(firstPrice).toBeLessThanOrEqual(50_000);
    expect(secondPrice).toBeGreaterThanOrEqual(1);
    expect(secondPrice).toBeLessThanOrEqual(50_000);
    expect(firstPrice).toBeGreaterThanOrEqual(200);
    expect(secondPrice).toBeGreaterThanOrEqual(200);
    expect(
      Buffer.compare(
        Buffer.from(conn.rawTransactions[0]!),
        Buffer.from(conn.rawTransactions[1]!),
      ),
    ).not.toBe(0);
    expect(conn.feeCalls).toBe(1);
    expect(conn.feeConfigs[0]?.lockedWritableAccounts?.[0]?.equals(marketPda)).toBe(
      true,
    );
  });

  it("caps huge recent-fee samples at the priority-fee ceiling", async () => {
    const conn = new PriorityFeeConnection({
      fees: [
        { slot: 1, prioritizationFee: 1_000_000 },
        { slot: 2, prioritizationFee: 2_000_000 },
        { slot: 3, prioritizationFee: 3_000_000 },
      ],
    });
    const { adapter, req, signer } = makeAdapter(conn);

    await adapter.submit(req as any, signer);

    const price = computeUnitPriceMicroLamports(conn.rawTransactions[0]!);
    expect(price).toBeGreaterThanOrEqual(49_000);
    expect(price).toBeLessThanOrEqual(50_000);
    expect(conn.feeCalls).toBe(1);
  });

  it("falls back gracefully when recent-fee lookup fails", async () => {
    const conn = new PriorityFeeConnection({
      feeError: new Error("recent prioritization fee RPC failed"),
    });
    const { adapter, req, signer } = makeAdapter(conn);

    await adapter.submit(req as any, signer);

    const price = computeUnitPriceMicroLamports(conn.rawTransactions[0]!);
    expect(price).toBeGreaterThanOrEqual(1);
    expect(price).toBeLessThanOrEqual(50_000);
    expect(conn.feeCalls).toBe(1);
  });
});
