// H5 (Codex): submit-failure path. The buy smoke covers the green path;
// this file proves that a guaranteed-fail tx (here: outcome=2, which fails
// the on-chain `outcome == NO || outcome == YES` guard with code 6001
// `InvalidOutcome`) raises a `SoothError` instead of being swallowed.
//
// Without the fix, `submit` returned a SubmitReceipt for failed txs because
// `confirmation.value.err` was never inspected. The bankrun shim's
// `processTransaction` throws on failure with a string carrying
// "custom program error: 0x..", so the regex-based decoder runs through
// the `sendRawTransaction` catch path — equivalent to the live
// `confirmTransaction.value.err` path on a real cluster.

import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";

import { SolanaChainAdapter } from "../src/adapter.js";
import { SoothError } from "../src/errors.js";
import { encodePubkeyRef, encodeSignatureRef } from "../src/refs.js";
import {
  deriveAmmStatePda,
  deriveMarketPda,
  deriveMarketVaultAta,
  derivePositionPda,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
} from "../src/pdas.js";
import { soothAmmIdl } from "../src/anchor/index.js";
import { WAD } from "../src/math/lmsr.js";

import { bootSmoke } from "./fixtures/setup.js";
import { BankrunConnection } from "./fixtures/bankrun-connection.js";

describe("submit failure surfacing", () => {
  it("InvalidOutcome (code 6001) raises SoothError, not silent receipt", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new BankrunConnection(smoke.ctx);
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
      ...soothAmmIdl,
      address: smoke.programs.soothAmm.toBase58(),
    };
    const program = new Program(ammIdl as any, provider);

    const badIx: TransactionInstruction = await (program.methods as any)
      .tradePositions(
        2, // INVALID outcome — guard returns 6001 InvalidOutcome
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
        user: smoke.user.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

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
    // Code 6001 = InvalidOutcome → mapped to "ProgramError" in the table
    // (we only mark slippage/insufficient/lifecycle codes as semantic
    // SoothError variants; the rest stay as ProgramError with the code).
    expect(err.kind).toBe("ProgramError");
    expect(err.fields.code).toBe(6001);
  }, /* timeout */ 60_000);
});
