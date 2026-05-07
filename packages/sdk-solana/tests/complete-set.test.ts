// buildMintCompleteSet / buildMergeCompleteSet — round-trip 10·USDC through
// the parity path (mint → outcome tokens → merge → USDC). Locks in:
//
//   1. Both builders produce a SoothRequest the existing submit() pipeline
//      lands on-chain (no special handling needed).
//   2. Mint adds idempotent ATA preIxs so a first-time minter doesn't need
//      a separate setup tx.
//   3. The on-chain accounting matches the e2e helper:
//      mint:  USDC -10·USDC, YES +10·WAD, NO +10·WAD
//      merge: USDC +10·USDC, YES -10·WAD, NO -10·WAD
//
// Keeping this test alongside the e2e adapter-direct mint helper
// (apps/demo/e2e/helpers/sdk-helpers.ts) prevents the two paths from
// drifting silently — if a future on-chain change breaks the IDL shape
// both will fail in lockstep.

import { describe, expect, it } from "vitest";
import { Transaction } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";

import { SolanaChainAdapter } from "../src/adapter.js";
import {
  encodePubkeyRef,
  deriveYesMintPda,
  deriveNoMintPda,
} from "../src/index.js";
import { WAD } from "../src/math/lmsr.js";

import { bootSmoke } from "./fixtures/setup.js";
import { BankrunConnection } from "./fixtures/bankrun-connection.js";

describe("complete-set parity (mint ↔ merge)", () => {
  it("mint 10 USDC → 10·WAD YES + 10·WAD NO; merge reverses cleanly", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n, // 100 USDC
    });
    const conn = new BankrunConnection(smoke.ctx);
    conn.setSimSigners([smoke.user]);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "smoke",
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

    const TEN_USDC = 10_000_000n;
    void WAD; // surfaced for readers — outcome tokens use USDC-decimal scale, not WAD

    const [yesMint] = deriveYesMintPda(smoke.marketId, smoke.programs);
    const [noMint] = deriveNoMintPda(smoke.marketId, smoke.programs);
    const userUsdcAta = getAssociatedTokenAddressSync(
      smoke.usdcMint,
      smoke.user.publicKey,
    );
    const userYesAta = getAssociatedTokenAddressSync(
      yesMint,
      smoke.user.publicKey,
    );
    const userNoAta = getAssociatedTokenAddressSync(
      noMint,
      smoke.user.publicKey,
    );

    // ── Pre-state ─────────────────────────────────────────────────────
    const usdcBefore = (await getAccount(conn, userUsdcAta)).amount;

    // ── Mint ──────────────────────────────────────────────────────────
    const mintReq = await adapter.buildMintCompleteSet(marketRef, {
      user: userRef,
      amount: TEN_USDC,
    });
    expect(mintReq.kind).toBe("trade");
    // costEstimateWad expresses the value moved, NOT the outcome-token
    // delta. amount * 1e12 lifts USDC base units (6 decimals) to WAD
    // (18 decimals) — same convention buildTrade uses on the AMM path.
    expect(mintReq.costEstimateWad).toBe(TEN_USDC * 1_000_000_000_000n);
    // Mint must include idempotent ATA preIxs.
    const mintMeta = mintReq.meta as { preIxs?: unknown[] };
    expect(mintMeta.preIxs?.length ?? 0).toBe(2);

    const mintReceipt = await adapter.submit(mintReq, signer);
    expect(mintReceipt.txId.startsWith("sol:")).toBe(true);

    const usdcAfterMint = (await getAccount(conn, userUsdcAta)).amount;
    const yesAfterMint = (await getAccount(conn, userYesAta)).amount;
    const noAfterMint = (await getAccount(conn, userNoAta)).amount;
    expect(usdcBefore - usdcAfterMint).toBe(TEN_USDC);
    // Outcome SPL mints carry 6 decimals (matching USDC), not WAD. The
    // AMM tracks WAD-scaled `yes_shares`/`no_shares` on Position internally,
    // but the SPL mints the user holds are 1 USDC = 1 outcome token at
    // matched 6-decimal scale.
    expect(yesAfterMint).toBe(TEN_USDC);
    expect(noAfterMint).toBe(TEN_USDC);

    // ── Merge ─────────────────────────────────────────────────────────
    const mergeReq = await adapter.buildMergeCompleteSet(marketRef, {
      user: userRef,
      amount: TEN_USDC,
    });
    expect(mergeReq.kind).toBe("trade");
    // Merge does NOT need ATA-create preIxs — the merge ix already
    // requires the ATAs to exist with non-zero balance.
    const mergeMeta = mergeReq.meta as { preIxs?: unknown[] };
    expect(mergeMeta.preIxs?.length ?? 0).toBe(0);

    const mergeReceipt = await adapter.submit(mergeReq, signer);
    expect(mergeReceipt.txId.startsWith("sol:")).toBe(true);

    const usdcAfterMerge = (await getAccount(conn, userUsdcAta)).amount;
    const yesAfterMerge = (await getAccount(conn, userYesAta)).amount;
    const noAfterMerge = (await getAccount(conn, userNoAta)).amount;
    expect(usdcAfterMerge).toBe(usdcBefore); // round-trip
    expect(yesAfterMerge).toBe(0n);
    expect(noAfterMerge).toBe(0n);
  }, 60_000);
});
