// buildRequestLock / buildAttestOutcome request-shape tests.
//
// Full settle flow + auth gating are covered by the cargo CPI suite
// (programs/sooth_adjudicator with cpi_dispute, programs/sooth_market
// with cpi_settle / cpi_lock_for_resolution, plus the on-chain
// e2e attest-settle spec at apps/demo/e2e/onchain/10-attest-settle-e2e).
// This test locks the SDK builder shapes — operation marker, account list,
// program ID — independently of test-validator wall-clock so the chain-
// shim's operator dispatchers can rely on them without re-instrumenting.

import { describe, expect, it } from "vitest";

import { SolanaChainAdapter } from "../src/adapter.js";
import { encodePubkeyRef, deriveAdjudicatorPda } from "../src/index.js";
import { WAD } from "../src/math/lmsr.js";

import { bootSmoke } from "./fixtures/setup.js";
import { BankrunConnection } from "./fixtures/bankrun-connection.js";

describe("operator request shapes", () => {
  it("buildRequestLock emits the right ix + account list", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new BankrunConnection(smoke.ctx);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "operator-shape",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      usdcMint: smoke.usdcMint,
      connection: conn,
    });

    const marketRef = encodePubkeyRef(smoke.marketPda);
    const userRef = encodePubkeyRef(smoke.user.publicKey);

    const req = await adapter.buildRequestLock(marketRef, { user: userRef });
    expect(req.kind).toBe("trade");
    const meta = req.meta as {
      operation?: string;
      ixProgramId?: string;
      ixKeys?: Array<{ pubkey: string }>;
    };
    expect(meta.operation).toBe("requestLock");
    expect(meta.ixProgramId).toBe(smoke.programs.soothAdjudicator!.toBase58());
    const keys = (meta.ixKeys ?? []).map((k) => k.pubkey);
    const [adjudicatorPda] = deriveAdjudicatorPda(smoke.marketPda, {
      ...smoke.programs,
      soothAdjudicator: smoke.programs.soothAdjudicator!,
    });
    expect(keys).toContain(adjudicatorPda.toBase58());
    expect(keys).toContain(smoke.marketPda.toBase58());
    expect(keys).toContain(smoke.user.publicKey.toBase58());
    expect(keys).toContain(smoke.programs.soothMarket.toBase58());
  });

  it("buildAttestOutcome rejects invalid outcome and accepts 0/1/2", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new BankrunConnection(smoke.ctx);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "attest-shape",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      usdcMint: smoke.usdcMint,
      connection: conn,
    });

    const marketRef = encodePubkeyRef(smoke.marketPda);
    const userRef = encodePubkeyRef(smoke.user.publicKey);

    // Invalid outcome → rejected at build time.
    await expect(
      adapter.buildAttestOutcome(marketRef, {
        user: userRef,
        // @ts-expect-error — deliberate bad value
        winningOutcome: 7,
      }),
    ).rejects.toThrow(/winningOutcome/i);

    // Valid YES (1).
    const yesReq = await adapter.buildAttestOutcome(marketRef, {
      user: userRef,
      winningOutcome: 1,
    });
    expect(yesReq.kind).toBe("trade");
    const yesMeta = yesReq.meta as {
      operation?: string;
      winningOutcome?: number;
    };
    expect(yesMeta.operation).toBe("attestOutcome");
    expect(yesMeta.winningOutcome).toBe(1);

    // Valid NO (0) and INVALID (2) just to round out the table.
    const noReq = await adapter.buildAttestOutcome(marketRef, {
      user: userRef,
      winningOutcome: 0,
    });
    expect((noReq.meta as { winningOutcome?: number }).winningOutcome).toBe(0);
    const invReq = await adapter.buildAttestOutcome(marketRef, {
      user: userRef,
      winningOutcome: 2,
    });
    expect((invReq.meta as { winningOutcome?: number }).winningOutcome).toBe(2);
  });
});
