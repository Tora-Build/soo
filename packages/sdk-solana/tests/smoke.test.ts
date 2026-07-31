// End-to-end smoke test: TS → Anchor → on-chain mutation → adapter reads.
//
// This is the load-bearing deliverable for the package scaffold. Without
// this test running green, the rest of the scaffold is just types. With it,
// we have a runnable proof-of-life for the AMM buy path that the eventual
// fork of `sooth-alpha/apps/demo` will exercise.
//
// Flow:
//   1. Boot LiteSVM with the Sooth program (loaded at their `declare_id!`
//      placeholder addresses).
//   2. Initialize a fresh USDC mint at the canonical devnet address (so the
//      `usdc_mint` constraint in `trade_positions` is satisfied).
//   3. Call `sooth_market::initialize_market` directly to create the Market
//      PDA, outcome mints, and vault.
//   4. Hand-write the `AmmState` PDA via `setAccount` because no on-chain
//      initializer exists (real on-chain bug — see report).
//   5. Mint USDC into the test user's ATA.
//   6. Call `adapter.readSnapshot` and `adapter.readQuote` — pre-trade reads.
//   7. Call `adapter.buildTrade({ side: "buy", outcome: YES, deltaShares,
//      maxCostWad })` to produce an unsigned `TradeRequest`.
//   8. Call `adapter.submit(req, signer)` — signs via the test user, sends
//      via the LiteSVM-backed Connection shim, "confirms" (no-op).
//   9. Call `adapter.readSnapshot` + `adapter.readPosition` and assert:
//      - `position.yesShares === deltaShares`
//      - `amm_state.q_yes === deltaShares`
//      - vault USDC balance increased by ~cost_usdc

import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  type VersionedTransaction,
  Transaction,
} from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

import { SolanaChainAdapter } from "../src/adapter.js";
import { encodePubkeyRef } from "../src/refs.js";
import { WAD, wadToUsdcCeil } from "../src/math/lmsr.js";

import { bootSmoke } from "./fixtures/setup.js";
import { LiteSvmConnection } from "./fixtures/svm.js";

describe("AMM buy smoke", () => {
  it("buy YES (~1% of b) end-to-end", async () => {
    const t0 = Date.now();
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const tBoot = Date.now() - t0;

    const conn = new LiteSvmConnection(smoke.ctx);
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

    // Pre-trade snapshot.
    const pre = await adapter.readSnapshot(marketRef, userRef);
    expect(pre.market.b).toBe(1_000n * WAD);
    expect(pre.market.qYes).toBe(0n);
    expect(pre.market.qNo).toBe(0n);
    expect(pre.market.isLive).toBe(true);
    expect(pre.position?.yesShares).toBe(0n);
    expect(pre.position?.noShares).toBe(0n);

    // Quote: buy 1% of b YES from empty book.
    const deltaShares = (1_000n * WAD) / 100n;
    const quote = await adapter.readQuote(marketRef, 1, deltaShares);
    // Mirrors the LMSR golden — should land near 5.0125 USDC equivalent
    // (5_012_499_947_917_016_000 WAD ± Taylor truncation).
    expect(quote.cost > 5_010_000_000_000_000_000n).toBe(true);
    expect(quote.cost < 5_015_000_000_000_000_000n).toBe(true);

    // Build the trade.
    const maxCostWad = quote.cost + WAD; // 1 USDC headroom
    const req = await adapter.buildTrade(marketRef, {
      // The Solana adapter requires the user pubkey at build time —
      // documented as a meta channel in `adapter.ts`.
      outcome: 1,
      deltaShares,
      maxCostWad,
      side: "buy",
      // @ts-expect-error — meta channel; not part of the vendored shape.
      user: userRef,
    });
    expect(req.kind).toBe("trade");
    expect(req.costEstimateWad).toBe(quote.cost);

    // Pre-trade vault balance is the LMSR subsidy the creator posted in
    // seed_lp — b * ln(2), ceil'd to USDC base units. It used to be 0 because
    // seed_lp never actually transferred anything (bug B0), which left the
    // vault unable to pay a winning position.
    const vaultPre = await adapter.getMarketVaultUsdcRaw(marketRef);
    const SUBSIDY = 693_147_181n; // ceil(1000e18 * ln2 / 1e12)
    expect(vaultPre).toBe(SUBSIDY);

    // Sign + submit. The test user signs via their Keypair; we adapt to
    // the `SolanaSigner` interface by wrapping in a closure that signs a
    // Transaction reconstructed from the bytes.
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

    const receipt = await adapter.submit(req, signer);
    expect(receipt.txId.startsWith("sol:")).toBe(true);
    expect(receipt.attempts).toBe(1);

    // Post-trade reads.
    const post = await adapter.readSnapshot(marketRef, userRef);
    expect(post.market.qYes).toBe(deltaShares);
    expect(post.market.qNo).toBe(0n);
    expect(post.position?.yesShares).toBe(deltaShares);
    expect(post.position?.noShares).toBe(0n);

    const position = await adapter.readPosition(marketRef, userRef);
    expect(position.yesShares).toBe(deltaShares);

    // Vault grows by exactly ceil(cost_wad / 1e12) on top of the subsidy.
    const expectedUsdc = wadToUsdcCeil(quote.cost);
    const vaultPost = await adapter.getMarketVaultUsdcRaw(marketRef);
    expect(vaultPost - vaultPre).toBe(expectedUsdc);

    const tTotal = Date.now() - t0;
    // Useful-on-failure log: vitest swallows console.log on success.
    // Targeting <30s total per the scaffolding plan.
    // eslint-disable-next-line no-console
    console.log(
      `smoke timing: boot=${tBoot}ms total=${tTotal}ms vaultUsdc=${vaultPost}`,
    );
  }, /* timeout */ 60_000);
});
