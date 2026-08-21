import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Transaction } from "@solana/web3.js";

import {
  CapturingConnection,
  mockSubmitAdapter,
} from "./fixtures/mock-submit.js";

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
    const conn = new CapturingConnection({
      fees: [
        { slot: 1, prioritizationFee: 10 },
        { slot: 2, prioritizationFee: 200 },
        { slot: 3, prioritizationFee: 300 },
      ],
    });
    const { adapter, req, signer, marketPda } = mockSubmitAdapter(conn);

    await adapter.submit(req, signer);
    await adapter.submit(req, signer);

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
    const conn = new CapturingConnection({
      fees: [
        { slot: 1, prioritizationFee: 1_000_000 },
        { slot: 2, prioritizationFee: 2_000_000 },
        { slot: 3, prioritizationFee: 3_000_000 },
      ],
    });
    const { adapter, req, signer } = mockSubmitAdapter(conn);

    await adapter.submit(req, signer);

    const price = computeUnitPriceMicroLamports(conn.rawTransactions[0]!);
    expect(price).toBeGreaterThanOrEqual(49_000);
    expect(price).toBeLessThanOrEqual(50_000);
    expect(conn.feeCalls).toBe(1);
  });

  it("falls back gracefully when recent-fee lookup fails", async () => {
    const conn = new CapturingConnection({
      feeError: new Error("recent prioritization fee RPC failed"),
    });
    const { adapter, req, signer } = mockSubmitAdapter(conn);

    await adapter.submit(req, signer);

    const price = computeUnitPriceMicroLamports(conn.rawTransactions[0]!);
    expect(price).toBeGreaterThanOrEqual(1);
    expect(price).toBeLessThanOrEqual(50_000);
    expect(conn.feeCalls).toBe(1);
  });
});
