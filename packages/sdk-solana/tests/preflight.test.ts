// preflight() — simulate-before-sign safety path.
//
// Mirrors the buy smoke setup, but calls `adapter.preflight(req)` instead of
// `submit(req, signer)`. Two cases:
//
//   1. Happy path: preflight a buy that would succeed → returns ok=true with
//      a positive gasEstimate (compute units consumed during simulation).
//   2. Failure path: preflight a buy whose `maxCostWad` is too tight →
//      simulation hits the on-chain `TooMuchSlippage` guard and preflight
//      returns ok=false with kind="SimulationFailed" carrying logs that
//      reference the slippage error.

import { describe, expect, it } from "vitest";

import { SolanaChainAdapter } from "../src/adapter.js";
import { encodePubkeyRef } from "../src/refs.js";
import { WAD } from "../src/math/lmsr.js";

import { bootSmoke } from "./fixtures/setup.js";
import { LiteSvmConnection } from "./fixtures/svm.js";

describe("preflight", () => {
  it("ok=true with positive gasEstimate on a sim'd buy", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new LiteSvmConnection(smoke.ctx);
    conn.setSimSigners([smoke.user]);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "smoke",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      bookMint: smoke.usdcMint,
      ammMint: smoke.ammMint,
      connection: conn,
    });

    const marketRef = encodePubkeyRef(smoke.marketPda);
    const userRef = encodePubkeyRef(smoke.user.publicKey);

    const deltaShares = (1_000n * WAD) / 100n;
    const quote = await adapter.readQuote(marketRef, 1, deltaShares);
    const req = await adapter.buildTrade(marketRef, {
      outcome: 1,
      deltaShares,
      maxCostWad: quote.cost + WAD,
      side: "buy",
      // @ts-expect-error — meta channel; not part of the vendored shape.
      user: userRef,
    });

    const result = await adapter.preflight(req);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(typeof result.gasEstimate).toBe("bigint");
    expect(result.gasEstimate).toBeGreaterThan(0n);
  });

  it("ok=false with SimulationFailed when maxCostWad is too tight", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new LiteSvmConnection(smoke.ctx);
    conn.setSimSigners([smoke.user]);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "smoke",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      bookMint: smoke.usdcMint,
      ammMint: smoke.ammMint,
      connection: conn,
    });

    const marketRef = encodePubkeyRef(smoke.marketPda);
    const userRef = encodePubkeyRef(smoke.user.publicKey);

    const deltaShares = (1_000n * WAD) / 100n;
    const req = await adapter.buildTrade(marketRef, {
      outcome: 1,
      deltaShares,
      // Cap below quote.cost — guaranteed slippage failure on-chain.
      maxCostWad: 1n,
      side: "buy",
      // @ts-expect-error — meta channel; not part of the vendored shape.
      user: userRef,
    });

    const result = await adapter.preflight(req);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("SimulationFailed");
    expect(result.gasEstimate).toBeUndefined();
  });

  it("ok=false with ProgramError when meta is missing ixData", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new LiteSvmConnection(smoke.ctx);
    conn.setSimSigners([smoke.user]);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "smoke",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      bookMint: smoke.usdcMint,
      ammMint: smoke.ammMint,
      connection: conn,
    });

    const result = await adapter.preflight({
      kind: "trade",
      meta: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("ProgramError");
  });
});
