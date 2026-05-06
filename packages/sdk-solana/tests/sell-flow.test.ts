// Sell-flow integration test: TS adapter → on-chain `sell_positions` ix.
//
// Wires up bankrun, executes a buy through `buildTrade` to seed a Position,
// then exercises the new `buildSell` + `submit` path. Asserts that:
//
//   - Position.yes_shares decreases by the sold amount.
//   - LockEntry PDA exists at the seeded address with the correct
//     `amount_usdc` and `unlock_at` (= now + 86400s).
//   - Position.lock_nonce was bumped (next sell produces a fresh PDA).
//   - The `lock_vault` ATA holds the proceeds USDC (drained from
//     `market_vault`).
//
// Companion to `smoke.test.ts` (buy path) and `claim-flow.test.ts` (lock
// elapse + drain).

import { describe, expect, it } from "vitest";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

import { SolanaChainAdapter } from "../src/adapter.js";
import { encodePubkeyRef } from "../src/refs.js";
import { WAD } from "../src/math/lmsr.js";
import {
  deriveLockEntryPda,
  deriveLockVaultAta,
  derivePositionPda,
} from "../src/pdas.js";

import { bootSmoke } from "./fixtures/setup.js";
import { BankrunConnection } from "./fixtures/bankrun-connection.js";

// NOTE on `.skip` — the on-chain `sell_positions` ix from Wave 1A has a
// PDA-signer bug: the `vault_authority` (and `lock_authority`) PDAs are
// owned by `sooth_market` (`seeds::program = sooth_market::ID` is pinned
// across the AMM ixs), but `sell_positions.rs` performs `invoke_signed`
// from `sooth_amm` with seeds `[b"vault", market_id, bump]` — those seeds
// derive a *different* PDA under `sooth_amm::ID`, so the signature check
// at the SPL-Token CPI fails with "Cross-program invocation with
// unauthorized signer or writable account". Same root cause for
// `claim_unlocked` (signs for `lock_authority`).
//
// The fix lives on the program side (either move vault/lock authorities
// under `sooth_amm::ID`, or add a `sooth_market` ix that the AMM CPIs to
// for the transfer). Per Wave 1B's task constraints we must not touch
// programs, so the assertions below are wired but the tests stay skipped
// until the program is re-rolled. Keep them in tree so the SDK side gets
// exercised the moment the program fix lands.
describe.skip("AMM sell flow", () => {
  it("buy 10 → sell 5 → Position.yes_shares decreases, LockEntry created", async () => {
    const t0 = Date.now();
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });

    const conn = new BankrunConnection(smoke.ctx);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "sell-flow",
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

    // ─── 1. BUY 10 YES ──────────────────────────────────────────────────
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
    const buyReceipt = await adapter.submit(buyReq, signer);
    expect(buyReceipt.txId.startsWith("sol:")).toBe(true);

    const afterBuy = await adapter.readPosition(marketRef, userRef);
    expect(afterBuy.yesShares).toBe(buyShares);
    expect(afterBuy.noShares).toBe(0n);

    // ─── 2. SELL 5 YES ──────────────────────────────────────────────────
    const sellShares = 5n * WAD;
    const sellReq = await adapter.buildSell(marketRef, {
      outcome: 1,
      deltaShares: sellShares,
      // No slippage protection — keeps the assertion focused on the
      // mutation. Production callers should pass a real lower bound.
      minProceedsWad: 0n,
      user: userRef,
    });
    expect(sellReq.kind).toBe("trade");
    expect(sellReq.costEstimateWad).toBeGreaterThan(0n);
    expect((sellReq.meta as any).operation).toBe("sell");

    const lockEntryFromMeta = (sellReq.meta as { lockEntryPda: string })
      .lockEntryPda;
    const lockNonceFromMeta = BigInt(
      (sellReq.meta as { lockNonceStr: string }).lockNonceStr,
    );
    // Lock nonce on a fresh Position (only one buy executed, never sold) is 0.
    expect(lockNonceFromMeta).toBe(0n);

    const sellReceipt = await adapter.submit(sellReq, signer);
    expect(sellReceipt.txId.startsWith("sol:")).toBe(true);

    // ─── 3. Position state after sell ───────────────────────────────────
    const afterSell = await adapter.readPosition(marketRef, userRef);
    expect(afterSell.yesShares).toBe(buyShares - sellShares);
    expect(afterSell.noShares).toBe(0n);

    // The Position.lock_nonce should have incremented to 1.
    const [positionPda] = derivePositionPda(
      smoke.marketId,
      smoke.user.publicKey,
      smoke.programs,
    );
    const positionAcc = await conn.getAccountInfo(positionPda);
    expect(positionAcc).not.toBeNull();
    // Position layout: 8 disc + 32 user + 32 market + 16 yes + 16 no + 8 lock_nonce + 1 bump
    // lock_nonce starts at offset 8 + 32 + 32 + 16 + 16 = 104.
    const lockNonceFromAcc = positionAcc!.data.readBigUInt64LE(104);
    expect(lockNonceFromAcc).toBe(1n);

    // ─── 4. LockEntry PDA exists with correct fields ────────────────────
    const [lockEntryPda] = deriveLockEntryPda(
      positionPda,
      lockNonceFromMeta,
      smoke.programs,
    );
    expect(lockEntryPda.toBase58()).toBe(lockEntryFromMeta);

    const lockEntryAcc = await conn.getAccountInfo(lockEntryPda);
    expect(lockEntryAcc).not.toBeNull();
    // LockEntry layout: 8 disc + 32 user + 32 market + 8 amount_usdc + 8 unlock_at + 8 nonce + 1 bump
    // amount_usdc at offset 8 + 32 + 32 = 72; unlock_at at 80; nonce at 88; bump at 96
    const amountUsdc = lockEntryAcc!.data.readBigUInt64LE(72);
    const unlockAt = lockEntryAcc!.data.readBigInt64LE(80);
    const nonceOnAcc = lockEntryAcc!.data.readBigUInt64LE(88);
    expect(amountUsdc).toBeGreaterThan(0n);
    expect(nonceOnAcc).toBe(0n);
    // bankrun fixture warps clock to startTime+1 == 1_000_001; LOCK_DURATION_SECS = 86400.
    expect(unlockAt).toBe(1_000_001n + 86_400n);

    // ─── 5. lock_vault USDC matches LockEntry.amount_usdc ───────────────
    const lockVaultAta = deriveLockVaultAta(
      smoke.marketId,
      smoke.usdcMint,
      smoke.programs,
    );
    const lockVaultAcc = await getAccount(conn, lockVaultAta);
    expect(lockVaultAcc.amount).toBe(amountUsdc);

    const tTotal = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(
      `sell-flow timing: total=${tTotal}ms amount_usdc=${amountUsdc} unlock_at=${unlockAt}`,
    );
  }, /* timeout */ 60_000);

  it("buildSell rejects deltaShares <= 0", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new BankrunConnection(smoke.ctx);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "sell-validate",
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

    await expect(
      adapter.buildSell(marketRef, {
        outcome: 1,
        deltaShares: 0n,
        minProceedsWad: 0n,
        user: userRef,
      }),
    ).rejects.toThrow(/deltaShares must be > 0/);
  }, /* timeout */ 60_000);

  it("buildSell rejects when no Position exists", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new BankrunConnection(smoke.ctx);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "sell-no-pos",
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

    // No buy yet → Position PDA absent; buildSell should refuse pre-flight.
    await expect(
      adapter.buildSell(marketRef, {
        outcome: 1,
        deltaShares: 1n * WAD,
        minProceedsWad: 0n,
        user: userRef,
      }),
    ).rejects.toThrow(/Position PDA not found/);
  }, /* timeout */ 60_000);
});
