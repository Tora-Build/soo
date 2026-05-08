import { describe, expect, it } from "vitest";
import { Transaction } from "@solana/web3.js";

import { SolanaChainAdapter } from "../src/adapter.js";
import { LN2_WAD, WAD } from "../src/math/lmsr.js";
import { encodePubkeyRef } from "../src/refs.js";

import { BankrunConnection } from "./fixtures/bankrun-connection.js";
import { bootSmoke } from "./fixtures/setup.js";

describe("readGraduationProgress", () => {
  it("reads fee accumulator and clamps progress in basis points", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new BankrunConnection(smoke.ctx);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "read-graduation",
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

    const initial = await adapter.readGraduationProgress(marketRef);
    expect(initial.feesAccumulatedWad).toBe(0n);
    expect(initial.thresholdWad).toBe((1_000n * WAD * LN2_WAD) / WAD);
    expect(initial.progressBps).toBe(0);
    expect(initial.isGraduated).toBe(false);

    const buyShares = 10n * WAD;
    const quote = await adapter.readQuote(marketRef, 1, buyShares);
    const req = await adapter.buildTrade(marketRef, {
      side: "buy",
      outcome: 1,
      deltaShares: buyShares,
      maxCostWad: quote.cost + WAD,
      // @ts-expect-error — Solana-only meta channel.
      user: userRef,
    });
    await adapter.submit(req, signer(smoke.user));

    const afterBuy = await adapter.readGraduationProgress(marketRef);
    expect(afterBuy.feesAccumulatedWad).toBe(quote.fee);
    expect(afterBuy.thresholdWad).toBe(initial.thresholdWad);
    expect(afterBuy.progressBps).toBe(
      Number((10_000n * quote.fee) / initial.thresholdWad),
    );
    expect(afterBuy.isGraduated).toBe(false);
  }, 60_000);
});

function signer(kp: Awaited<ReturnType<typeof bootSmoke>>["user"]) {
  return {
    publicKey: kp.publicKey.toBase58(),
    signTransaction: async (raw: Uint8Array): Promise<Uint8Array> => {
      const tx = Transaction.from(raw);
      tx.partialSign(kp);
      return tx.serialize({
        verifySignatures: false,
        requireAllSignatures: false,
      });
    },
  };
}
