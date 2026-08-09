// Claim-flow integration test: extends the sell flow with a clock warp past
// `unlock_at` and asserts that `claim_unlocked` drains the LockEntry's
// USDC back to the user's USDC ATA, and that the LockEntry account is
// closed (Anchor's `close = user`).
//
// Companion to `sell-flow.test.ts`.

import { describe, expect, it } from "vitest";
import { Transaction } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { Clock } from "./fixtures/svm.js";

import { SolanaChainAdapter } from "../src/adapter.js";
import { encodePubkeyRef } from "../src/refs.js";
import { WAD } from "../src/math/lmsr.js";
import {
  deriveLockEntryPda,
  deriveLockVaultAta,
  derivePositionPda,
  deriveUserUsdcAta,
} from "../src/pdas.js";

import { bootSmoke } from "./fixtures/setup.js";
import { LiteSvmConnection } from "./fixtures/svm.js";

// Wave 1B fix landed — see the matching note at the top of
// `sell-flow.test.ts`. Both `sell_positions` and `claim_unlocked` now CPI
// into `sooth_market` helpers for the PDA-signed transfers.
describe("AMM claim_unlocked flow", () => {
  it("buy → sell → warp clock → claim drains lock_vault → user ATA", async () => {
    const t0 = Date.now();
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });

    const conn = new LiteSvmConnection(smoke.ctx);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "claim-flow",
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

    // ─── 1. BUY 10 ──────────────────────────────────────────────────────
    const buyShares = 10n * WAD;
    const buyQuote = await adapter.readQuote(marketRef, 1, buyShares);
    const buyReq = await adapter.buildTrade(marketRef, {
      side: "buy",
      outcome: 1,
      deltaShares: buyShares,
      maxCostWad: buyQuote.cost + WAD,
      // @ts-expect-error — Solana-only meta channel.
      user: userRef,
    });
    await adapter.submit(buyReq, signer);

    // ─── 2. SELL 5 ──────────────────────────────────────────────────────
    const sellShares = 5n * WAD;
    const sellReq = await adapter.buildSell(marketRef, {
      outcome: 1,
      deltaShares: sellShares,
      minProceedsWad: 0n,
      user: userRef,
    });
    const lockEntryRef = `sol:${(sellReq.meta as { lockEntryPda: string }).lockEntryPda}`;
    await adapter.submit(sellReq, signer);

    const [positionPda] = derivePositionPda(
      smoke.marketId,
      smoke.user.publicKey,
      smoke.programs,
    );
    const [lockEntryPda] = deriveLockEntryPda(
      positionPda,
      0n, // first sell → nonce 0
      smoke.programs,
    );
    const lockVaultAta = deriveLockVaultAta(smoke.marketId, smoke.ammMint,
      smoke.programs,
    );
    const userAta = deriveUserUsdcAta(smoke.user.publicKey, smoke.ammMint);

    const lockEntryAcc = await conn.getAccountInfo(lockEntryPda);
    expect(lockEntryAcc).not.toBeNull();
    const lockedAmount = lockEntryAcc!.data.readBigUInt64LE(72);
    expect(lockedAmount).toBeGreaterThan(0n);

    const userBalanceAfterSell = (await getAccount(conn, userAta)).amount;
    const lockVaultAfterSell = (await getAccount(conn, lockVaultAta)).amount;
    expect(lockVaultAfterSell).toBe(lockedAmount);

    // ─── 3. Attempt to claim BEFORE unlock_at — should fail (LockNotElapsed) ──
    const claimReqEarly = await adapter.buildClaim(marketRef, {
      outcome: 0,
      user: userRef,
      lockEntry: lockEntryRef,
    });
    let earlyError: unknown = null;
    try {
      await adapter.submit(claimReqEarly, signer);
    } catch (e) {
      earlyError = e;
    }
    expect(earlyError).not.toBeNull();
    // The error is mapped via `SOOTH_AMM_ERROR_TABLE` → kind: LockNotElapsed.
    expect((earlyError as { kind?: string }).kind).toBe("LockNotElapsed");

    // ─── 4. Warp the clock past unlock_at ───────────────────────────────
    // Two things happen here:
    //   1. `warpToSlot` advances the bank to a fresh slot. LiteSVM caches the
    //      most-recent blockhash per slot; without an advance, the late-claim
    //      tx would land on the *same* blockhash as the early-claim tx.
    //      That makes the two tx messages byte-identical (same ix, same
    //      accounts, same recent_blockhash) → identical signature → the SVM's
    //      dedup rejects the second send with "transaction has already been
    //      processed". This was the root cause of the ~50% flake rate.
    //   2. `setClock` overwrites the clock sysvar's `unix_timestamp` so the
    //      on-chain `Clock::get()?.unix_timestamp >= unlock_at` check passes.
    //      `warpToSlot` resets the sysvar's slot to the new value but does
    //      NOT change `unix_timestamp`, so we set it explicitly afterwards
    //      using the post-warp slot.
    const unlockAt = lockEntryAcc!.data.readBigInt64LE(80);
    const preWarpClock = await smoke.ctx.banksClient.getClock();
    smoke.ctx.warpToSlot(preWarpClock.slot + 1n);
    const postWarpClock = await smoke.ctx.banksClient.getClock();
    smoke.ctx.setClock(
      new Clock(
        postWarpClock.slot,
        postWarpClock.epochStartTimestamp,
        postWarpClock.epoch,
        postWarpClock.leaderScheduleEpoch,
        unlockAt + 1n,
      ),
    );

    // ─── 5. Claim — should succeed ──────────────────────────────────────
    const claimReq = await adapter.buildClaim(marketRef, {
      outcome: 0,
      user: userRef,
      lockEntry: lockEntryRef,
    });
    expect(claimReq.kind).toBe("claim");
    expect((claimReq.meta as any).operation).toBe("claim");

    const claimReceipt = await adapter.submit(claimReq, signer);
    expect(claimReceipt.txId.startsWith("sol:")).toBe(true);

    // ─── 6. Post-conditions ─────────────────────────────────────────────
    // user_usdc_ata credited by lockedAmount.
    const userBalanceAfterClaim = (await getAccount(conn, userAta)).amount;
    expect(userBalanceAfterClaim).toBe(userBalanceAfterSell + lockedAmount);

    // lock_vault drained.
    const lockVaultAfterClaim = (await getAccount(conn, lockVaultAta)).amount;
    expect(lockVaultAfterClaim).toBe(0n);

    // LockEntry closed (`close = user` in claim_unlocked.rs).
    const lockEntryAfter = await conn.getAccountInfo(lockEntryPda);
    expect(lockEntryAfter).toBeNull();

    const tTotal = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(
      `claim-flow timing: total=${tTotal}ms drained=${lockedAmount} unlock_at=${unlockAt}`,
    );
  }, /* timeout */ 90_000);
});
