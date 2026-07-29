// H5 (Codex): submit-failure path. The buy smoke covers the green path;
// this file proves that a guaranteed-fail tx (here: outcome=2, which fails
// the on-chain `outcome == NO || outcome == YES` guard with code 6003
// `InvalidOutcome`) raises a `SoothError` instead of being swallowed.
//
// Without the fix, `submit` returned a SubmitReceipt for failed txs because
// `confirmation.value.err` was never inspected. The LiteSVM shim's
// `processTransaction` throws on failure with a string carrying
// "custom program error: 0x..", so the regex-based decoder runs through
// the `sendRawTransaction` catch path — equivalent to the live
// `confirmTransaction.value.err` path on a real cluster.
//
// H5 2nd-pass (Codex): bounded retry/resend. The new `submit()` distinguishes
// retryable failures (BlockhashNotFound, RPC blips) from terminal ones
// (program errors 6000-6011, signature/balance issues). The retry tests
// below use a `MockConnection` rather than LiteSVM because LiteSVM's
// in-memory ledger doesn't simulate blockhash expiry.

import { describe, expect, it } from "vitest";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  type AccountInfo,
  type Commitment,
  type RpcResponseAndContext,
  type SignatureResult,
  type SignatureStatus,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";

import { SolanaChainAdapter } from "../src/adapter.js";
import { SoothError } from "../src/errors.js";
import {
  deriveAmmStatePda,
  deriveFeePoolAuthorityPda,
  deriveLpMintAuthorityPda,
  deriveLpMintPda,
  deriveMarketVaultAta,
  derivePositionPda,
  deriveProtocolConfigPda,
  deriveUserLpAta,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  marketFeePoolPda,
  type ProgramIds,
} from "../src/pdas.js";
import { soothCoreIdl } from "../src/anchor/index.js";
import { WAD } from "../src/math/lmsr.js";

import { bootSmoke } from "./fixtures/setup.js";
import { LiteSvmConnection } from "./fixtures/svm.js";

describe("submit failure surfacing", () => {
  it("InvalidOutcome (code 6003) raises SoothError, not silent receipt", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new LiteSvmConnection(smoke.ctx);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "submit-fail",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      usdcMint: smoke.usdcMint,
      connection: conn,
    });

    // Build a `trade_positions` ix manually with `outcome = 2`. The SDK's
    // `buildTrade` validates outcome client-side so we have to bypass it
    // by hand-rolling the meta — same shape `submit` reads from.
    const [ammPda] = deriveAmmStatePda(smoke.marketId, smoke.programs);
    const [positionPda] = derivePositionPda(
      smoke.marketId,
      smoke.user.publicKey,
      smoke.programs,
    );
    const [vaultAuthority] = deriveVaultAuthorityPda(
      smoke.marketId,
      smoke.programs,
    );
    const userUsdcAta = deriveUserUsdcAta(smoke.user.publicKey, smoke.usdcMint);
    const marketVault = deriveMarketVaultAta(
      smoke.marketId,
      smoke.usdcMint,
      smoke.programs,
    );

    // We need a real `tradePositions` ix with bad outcome. Easiest path is
    // through the same Anchor `Program` the adapter uses internally — so
    // we construct one with the smoke fixture's connection.
    const { Program, AnchorProvider } = await import("@coral-xyz/anchor");
    const stubWallet = {
      publicKey: smoke.user.publicKey,
      payer: smoke.user,
      signTransaction: async (tx: any) => {
        (tx as Transaction).partialSign(smoke.user);
        return tx;
      },
      signAllTransactions: async (txs: any[]) => {
        for (const tx of txs) (tx as Transaction).partialSign(smoke.user);
        return txs;
      },
    } as any;
    const provider = new AnchorProvider(conn, stubWallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    const ammIdl = {
      ...soothCoreIdl,
      address: smoke.programs.soothCore.toBase58(),
    };
    const program = new Program(ammIdl as any, provider);

    // LP-mint accounts (architecture §4.2). Anchor would attempt to auto-
    // resolve these from the IDL's `pda` blocks, but the resolver hits the
    // 6-deep recursion ceiling on `market.market_id` chasing — derive
    // explicitly and pass through.
    const [lpMint] = deriveLpMintPda(smoke.marketId, smoke.programs);
    const [lpMintAuthority] = deriveLpMintAuthorityPda(smoke.marketId, smoke.programs);
    const userLpAta = deriveUserLpAta(smoke.user.publicKey, lpMint);

    const badIx: TransactionInstruction = await (program.methods as any)
      .tradePositions(
        2, // INVALID outcome — guard returns 6003 InvalidOutcome
        new BN((1n * WAD).toString()),
        new BN((10n * WAD).toString()),
      )
      .accounts({
        market: smoke.marketPda,
        ammState: ammPda,
        position: positionPda,
        vaultAuthority,
        userUsdcAta,
        marketVault,
        usdcMint: smoke.usdcMint,
        // Fee path: trade_positions reads the singleton ProtocolConfig PDA
        // and credits the per-market fee pool owned by sooth_launchpad.
        // bootSmoke initialises both before this test fires the bad ix.
        protocolConfig: deriveProtocolConfigPda(smoke.programs)[0],
        marketFeePool: marketFeePoolPda(smoke.marketId, smoke.programs)[0],
        lpMint,
        lpMintAuthority,
        userLpAta,
        user: smoke.user.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
        soothLaunchpadProgram: smoke.programs.soothCore,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    // Pre-ix 1: init the per-market fee-pool token account. `market_fee_pool`
    // appears in the TradePositions account struct before `user_lp_ata`, so a
    // missing fee pool surfaces as `AccountNotInitialized = 3012` before the
    // handler even reaches the `outcome` guard. We init it here so the fee
    // pool exists when the bad ix runs. The whole tx rolls back on the 6003
    // failure, so the fee pool is not persisted — that is the correct outcome.
    const [feePoolAuthority] = deriveFeePoolAuthorityPda(smoke.programs);
    const [feePoolPda] = marketFeePoolPda(smoke.marketId, smoke.programs);
    const initFeePoolIx: TransactionInstruction = await (program.methods as any)
      .initMarketFeePool()
      .accounts({
        market: smoke.marketPda,
        feePoolAuthority,
        usdcMint: smoke.usdcMint,
        marketFeePool: feePoolPda,
        signer: smoke.user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    // Pre-ix 2: idempotent ATA-create for `user_lp_ata`. Anchor's
    // `try_accounts` runs the LP-ATA `token::mint = lp_mint, token::
    // authority = user` constraint BEFORE the handler's `outcome`
    // validation, so a missing LP ATA would surface as
    // `AccountNotInitialized = 3012` rather than the `InvalidOutcome
    // = 6003` we want to assert. Match the same pre-ix `buildTrade`
    // ships through `meta.preIxs`.
    const lpAtaCreateIx = createAssociatedTokenAccountIdempotentInstruction(
      smoke.user.publicKey,
      userLpAta,
      smoke.user.publicKey,
      lpMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    // Hand-build the same shape `buildTrade` returns — submit reads ixData /
    // ixKeys / ixProgramId / userPk off req.meta.
    const req = {
      kind: "trade" as const,
      serializedTx: undefined,
      costEstimateWad: 0n,
      accounts: [],
      meta: {
        marketPda: smoke.marketPda.toBase58(),
        userPk: smoke.user.publicKey.toBase58(),
        ixData: Buffer.from(badIx.data).toString("base64"),
        ixKeys: badIx.keys.map((k) => ({
          pubkey: k.pubkey.toBase58(),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
        ixProgramId: badIx.programId.toBase58(),
        preIxs: [
          {
            programId: initFeePoolIx.programId.toBase58(),
            keys: initFeePoolIx.keys.map((k) => ({
              pubkey: k.pubkey.toBase58(),
              isSigner: k.isSigner,
              isWritable: k.isWritable,
            })),
            data: Buffer.from(initFeePoolIx.data).toString("base64"),
          },
          {
            programId: lpAtaCreateIx.programId.toBase58(),
            keys: lpAtaCreateIx.keys.map((k) => ({
              pubkey: k.pubkey.toBase58(),
              isSigner: k.isSigner,
              isWritable: k.isWritable,
            })),
            data: Buffer.from(lpAtaCreateIx.data).toString("base64"),
          },
        ],
        deltaSharesStr: "1",
        maxCostWadStr: "10",
        outcome: 2,
      },
    };

    const signer = {
      publicKey: smoke.user.publicKey.toBase58(),
      signTransaction: async (raw: Uint8Array): Promise<Uint8Array> => {
        const tx = Transaction.from(raw);
        tx.partialSign(smoke.user);
        return tx.serialize({
          verifySignatures: false,
          requireAllSignatures: false,
        });
      },
    };

    let caught: unknown;
    try {
      await adapter.submit(req as any, signer);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SoothError);
    const err = caught as SoothError;
    // Code 6003 = InvalidOutcome in the SoothCoreError enum → mapped to
    // "ProgramError" in the error table (we only mark slippage/insufficient/
    // lifecycle codes as semantic SoothError variants; the rest stay as
    // ProgramError with the code).
    expect(err.kind).toBe("ProgramError");
    expect(err.fields.code).toBe(6003);
    // H5 2nd-pass: program errors are terminal — never retry. The classifier
    // stamps `attempt: 1` on the SoothError so callers can correlate with
    // SubmitReceipt.attempts (which is absent here because we threw).
    expect(err.fields.attempt).toBe(1);
  }, /* timeout */ 60_000);
});

// ─── Retry policy tests ────────────────────────────────────────────────────

// Minimal `Connection`-shaped mock for retry tests. We control:
//   - getLatestBlockhash → returns a counter-tagged blockhash so we can
//     assert the SDK fetches a fresh one each attempt.
//   - sendRawTransaction → caller-supplied behavior keyed off attempt index.
//   - confirmTransaction → caller-supplied; defaults to ok.
class MockConnection extends Connection {
  attempts = 0;
  blockhashesIssued: string[] = [];

  constructor(
    private readonly script: {
      send?: (
        attempt: number,
        bytes: Uint8Array,
      ) => Promise<string> | string | Error;
      confirm?: (attempt: number, sig: string) => unknown;
      getBlockhash?: (attempt: number) => Error | undefined;
    },
  ) {
    super("http://127.0.0.1:8899", "confirmed");
  }

  override async getLatestBlockhash(_c?: Commitment): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    const i = this.blockhashesIssued.length + 1;
    const hookErr = this.script.getBlockhash?.(i);
    if (hookErr) throw hookErr;
    // Real-shaped 32-byte base58 from a deterministic Keypair seed —
    // `Transaction.serialize()` decodes the blockhash back to bytes, so a
    // bogus string would throw inside web3.js.
    const blockhash = Keypair.generate().publicKey.toBase58();
    this.blockhashesIssued.push(blockhash);
    return { blockhash, lastValidBlockHeight: 1000 + i };
  }

  override async sendRawTransaction(
    rawTransaction: Buffer | Uint8Array | Array<number>,
  ): Promise<string> {
    this.attempts += 1;
    const bytes =
      rawTransaction instanceof Uint8Array
        ? rawTransaction
        : new Uint8Array(rawTransaction as ArrayLike<number>);
    const result = await this.script.send?.(this.attempts, bytes);
    if (result instanceof Error) throw result;
    if (typeof result === "string") return result;
    // Default — fabricate a signature derived from attempt index.
    return `sig-attempt-${this.attempts}`;
  }

  override async confirmTransaction(
    strategy: any,
    _commitment?: Commitment,
  ): Promise<RpcResponseAndContext<SignatureResult>> {
    const sig: string =
      typeof strategy === "string" ? strategy : (strategy?.signature ?? "");
    const result = this.script.confirm?.(this.attempts, sig);
    if (result instanceof Error) throw result;
    if (result && typeof result === "object" && "err" in result) {
      return {
        context: { slot: 0 },
        value: result as SignatureResult,
      };
    }
    return { context: { slot: 0 }, value: { err: null } };
  }

  // The adapter confirms via getSignatureStatus polling rather than the
  // websocket-backed confirmTransaction. Drive it from the same `confirm`
  // script hook so existing test scenarios keep their meaning:
  //   Error   → thrown, i.e. the tx never became visible (retryable)
  //   { err } → landed but reverted
  //   default → landed cleanly
  override async getSignatureStatus(
    signature: string,
  ): Promise<RpcResponseAndContext<SignatureStatus | null>> {
    const result = this.script.confirm?.(this.attempts, signature);
    if (result instanceof Error) throw result;
    const err =
      result && typeof result === "object" && "err" in result
        ? (result as SignatureResult).err
        : null;
    return {
      context: { slot: 0 },
      value: { slot: 0, confirmations: 0, err, confirmationStatus: "confirmed" },
    };
  }

  // The constructor still calls into the base path for getAccountInfo etc.
  // We don't expect submit to use them; if it does the test will surface a
  // network error from the real RPC URL — caught by the test wrapper.
  override async getAccountInfo(
    _publicKey: PublicKey,
    _commitment?: Commitment,
  ): Promise<AccountInfo<Buffer> | null> {
    return null;
  }
}

// Minimal request shape that `submit()` accepts. Fields are bogus but
// well-formed so the meta path doesn't reject.
function buildMockRequest(programs: ProgramIds, userPk: PublicKey) {
  // A trivial system-transfer-like ix data; submit doesn't execute it, the
  // mock send/confirm callbacks decide success/failure.
  const ix = new TransactionInstruction({
    programId: programs.soothCore,
    keys: [{ pubkey: userPk, isSigner: true, isWritable: true }],
    data: Buffer.alloc(8),
  });
  return {
    kind: "trade" as const,
    serializedTx: undefined,
    costEstimateWad: 0n,
    accounts: [],
    meta: {
      marketPda: programs.soothCore.toBase58(),
      userPk: userPk.toBase58(),
      ixData: Buffer.from(ix.data).toString("base64"),
      ixKeys: ix.keys.map((k) => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      ixProgramId: ix.programId.toBase58(),
      deltaSharesStr: "0",
      maxCostWadStr: "0",
      outcome: 1,
    },
  };
}

describe("submit retry policy", () => {
  // The retry tests don't need a live SVM chain — only a Keypair for the
  // signer and stable program IDs to construct an adapter. Generating these
  // locally also avoids the smoke fixture's pre-existing setup dependency
  // (`adjudicator_allowlist` init), which is orthogonal to retry logic.
  function makeRetryAdapter(connection: Connection) {
    const programs: ProgramIds = {
      soothCore: new PublicKey(soothCoreIdl.address),
    };
    const userKp = Keypair.generate();
    const usdcMint = new PublicKey(
      "H7hBn9A1MDuKLhLji26bkRv5P3zMnp9jQmxNo76wsGyK",
    );
    const adapter = new SolanaChainAdapter({
      node: {
        id: "retry-test",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: programs,
      usdcMint,
      connection,
    });
    const signer = {
      publicKey: userKp.publicKey.toBase58(),
      signTransaction: async (raw: Uint8Array): Promise<Uint8Array> => {
        // submit() serialized with verifySignatures:false — we don't actually
        // need to sign because the MockConnection never decodes the bytes.
        // Pass-through is correct.
        return raw;
      },
    };
    const req = buildMockRequest(programs, userKp.publicKey);
    return { adapter, signer, req, programs, userPk: userKp.publicKey };
  }

  it("retryable failure then success: attempts === 2", async () => {
    const conn = new MockConnection({
      send: (attempt) => {
        if (attempt === 1) {
          // Solana-CLI shape — `sendRawTransaction` rejects with the well-
          // known "Blockhash not found" string before the tx ever gets
          // simulated. The classifier matches on the lowercased substring.
          return new Error(
            "failed to send transaction: Blockhash not found in cache",
          );
        }
        return `sig-attempt-${attempt}`;
      },
    });
    const { adapter, signer, req } = makeRetryAdapter(conn);

    const receipt = await adapter.submit(req as any, signer);
    expect(receipt.attempts).toBe(2);
    expect(receipt.txId).toMatch(/^sol:sig-attempt-2/);
    // Two blockhashes fetched — one per attempt — confirms re-resolve.
    expect(conn.blockhashesIssued.length).toBe(2);
  }, 30_000);

  it("terminal program error: throws on attempt 1, no retry", async () => {
    const conn = new MockConnection({
      send: () => {
        // Anchor user-error 6003 = InvalidOutcome → 0x1773 hex.
        return new Error(
          "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1773",
        );
      },
    });
    const { adapter, signer, req } = makeRetryAdapter(conn);

    let caught: unknown;
    try {
      await adapter.submit(req as any, signer);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SoothError);
    const err = caught as SoothError;
    expect(err.kind).toBe("ProgramError");
    expect(err.fields.code).toBe(6003);
    expect(err.fields.attempt).toBe(1);
    // Mock observed exactly one send — no retry on terminal program error.
    expect(conn.attempts).toBe(1);
  }, 30_000);

  it("max retries exceeded: throws SoothError matching last failure", async () => {
    const conn = new MockConnection({
      send: () => {
        return new Error(
          "failed to send transaction: Blockhash not found in cache",
        );
      },
    });
    const { adapter, signer, req } = makeRetryAdapter(conn);

    // Cap to 3 attempts via SubmitOptions so the test runs fast (200+400ms
    // backoffs vs 200+400+800+1600ms for the default 5).
    let caught: unknown;
    try {
      await adapter.submit(req as any, signer, { maxAttempts: 3 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SoothError);
    const err = caught as SoothError;
    expect(err.kind).toBe("NetworkError");
    // Last failure was attempt 3 (the cap).
    expect(err.fields.attempt).toBe(3);
    expect(conn.attempts).toBe(3);
  }, 30_000);

  it("maxAttempts clamped to spec ceiling (5)", async () => {
    const conn = new MockConnection({
      send: () => {
        return new Error(
          "failed to send transaction: Blockhash not found in cache",
        );
      },
    });
    const { adapter, signer, req } = makeRetryAdapter(conn);

    // Caller asks for 100 — spec caps at 5.
    let caught: unknown;
    try {
      await adapter.submit(req as any, signer, { maxAttempts: 100 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SoothError);
    expect(conn.attempts).toBe(5);
  }, 30_000);

  // Regression: confirmation must not go through `confirmTransaction`, which
  // subscribes via websocket `signatureSubscribe`. Alchemy's HTTP endpoint
  // answers that with "Method not found", so confirmation threw a spurious
  // timeout and submit retried a tx that had ALREADY landed — the replayed
  // non-idempotent InitMarketFeePool preIx then failed with Custom(0),
  // surfacing "Trade failed: code=0" for a trade that actually executed.
  //
  // This connection reproduces exactly that RPC: confirmTransaction throws,
  // getSignatureStatus answers normally. A correct adapter never calls the
  // former, so the landed tx confirms on attempt 1.
  it("confirms via getSignatureStatus, never websocket confirmTransaction", async () => {
    let confirmTransactionCalls = 0;
    class WsRejectingConnection extends MockConnection {
      override async confirmTransaction(): Promise<never> {
        confirmTransactionCalls += 1;
        throw new Error("failed to get signature status: Method not found");
      }
    }

    const conn = new WsRejectingConnection({});
    const { adapter, signer, req } = makeRetryAdapter(conn);

    const receipt = await adapter.submit(req as any, signer);

    expect(confirmTransactionCalls).toBe(0);
    // Landed on the first send, so no resend and no replayed preIxs.
    expect(receipt.attempts).toBe(1);
    expect(conn.attempts).toBe(1);
    expect(conn.blockhashesIssued.length).toBe(1);
  }, 30_000);
});
