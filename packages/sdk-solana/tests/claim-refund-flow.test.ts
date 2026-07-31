import { describe, expect, it } from "vitest";
import { getAccount } from "@solana/spl-token";
import { Clock } from "./fixtures/svm.js";
import { Transaction } from "@solana/web3.js";

import { SolanaChainAdapter } from "../src/adapter.js";
import { WAD, wadToUsdcCeil } from "../src/math/lmsr.js";
import { derivePositionPda, deriveUserUsdcAta } from "../src/pdas.js";
import { encodePubkeyRef } from "../src/refs.js";

import { LiteSvmConnection } from "./fixtures/svm.js";
import { bootSmoke } from "./fixtures/setup.js";

describe("dismissed-market refund flow", () => {
  it("buy → pre-dismiss refund reject → dismiss → claim_refund pays locked cost and closes Position", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new LiteSvmConnection(smoke.ctx);
    const adapter = buildAdapter(smoke, conn, "claim-refund-flow");
    const marketRef = encodePubkeyRef(smoke.marketPda);
    const userRef = encodePubkeyRef(smoke.user.publicKey);
    const creatorRef = encodePubkeyRef(smoke.creator.publicKey);
    const userSigner = signer(smoke.user);

    const buyShares = 5n * WAD;
    const quote = await adapter.readQuote(marketRef, 1, buyShares);
    const buyReq = await adapter.buildTrade(marketRef, {
      side: "buy",
      outcome: 1,
      deltaShares: buyShares,
      maxCostWad: quote.cost + WAD,
      // @ts-expect-error — Solana-only meta channel.
      user: userRef,
    });
    await adapter.submit(buyReq, userSigner);

    const expectedLockedCost = wadToUsdcCeil(quote.cost);
    const position = await adapter.readPosition(marketRef, userRef);
    expect(position.yesShares).toBe(buyShares);
    expect(position.lockedCostUsdc).toBe(expectedLockedCost);

    const [positionPda] = derivePositionPda(
      smoke.marketId,
      smoke.user.publicKey,
      smoke.programs,
    );
    const positionAcc = await conn.getAccountInfo(positionPda);
    expect(positionAcc).not.toBeNull();
    expect(positionAcc!.data.readBigUInt64LE(104)).toBe(expectedLockedCost);

    const earlyReq = await adapter.buildClaimRefund(marketRef, {
      user: userRef,
    });
    await expect(adapter.submit(earlyReq, userSigner)).rejects.toMatchObject({
      kind: "MarketNotDismissed",
    });

    const ammAcc = await conn.getAccountInfo(smoke.ammStatePda);
    expect(ammAcc).not.toBeNull();
    const trialEndAt = ammAcc!.data.readBigInt64LE(136);
    await warpClock(smoke.ctx, trialEndAt + 1n);

    const dismissReq = await adapter.buildDismissMarket(marketRef, {
      user: creatorRef,
    });
    await adapter.submit(dismissReq, signer(smoke.creator));

    await warpClock(smoke.ctx, trialEndAt + 2n);

    const userAta = deriveUserUsdcAta(smoke.user.publicKey, smoke.usdcMint);
    const userBalanceBeforeClaim = (await getAccount(conn, userAta)).amount;
    const marketVaultBeforeClaim = await adapter.getMarketVaultUsdcRaw(
      marketRef,
    );
    // The vault holds the trader's locked cost ON TOP of the LMSR subsidy that
    // seed_lp now posts (b * ln(2), ~693.15 USDC at b = 1000). Before bug B0
    // was fixed, seed_lp transferred nothing and this was just the locked cost.
    const LMSR_SUBSIDY = 693_147_181n;
    expect(marketVaultBeforeClaim).toBe(LMSR_SUBSIDY + expectedLockedCost);

    const claimReq = await adapter.buildClaimRefund(marketRef, {
      user: userRef,
    });
    expect(claimReq.kind).toBe("claim");
    expect((claimReq.meta as { operation?: string }).operation).toBe(
      "claimRefund",
    );

    const receipt = await adapter.submit(claimReq, userSigner);
    expect(receipt.txId.startsWith("sol:")).toBe(true);

    const userBalanceAfterClaim = (await getAccount(conn, userAta)).amount;
    expect(userBalanceAfterClaim).toBe(
      userBalanceBeforeClaim + expectedLockedCost,
    );
    // The refund returns the trader's locked cost. What remains is the
    // creator's subsidy — dismissal does not claw that back, and there is no
    // path yet for the creator to reclaim it (tracked as B0-followup).
    expect(await adapter.getMarketVaultUsdcRaw(marketRef)).toBe(LMSR_SUBSIDY);
    expect(await conn.getAccountInfo(positionPda)).toBeNull();
  }, 90_000);
});

function buildAdapter(
  smoke: Awaited<ReturnType<typeof bootSmoke>>,
  conn: LiteSvmConnection,
  id: string,
): SolanaChainAdapter {
  return new SolanaChainAdapter({
    node: {
      id,
      chainKind: "solana",
      chainId: "test",
      rpcUrl: "http://localhost:8899",
    },
    programIds: smoke.programs,
    usdcMint: smoke.usdcMint,
    connection: conn,
  });
}

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

async function warpClock(
  ctx: Awaited<ReturnType<typeof bootSmoke>>["ctx"],
  unixTimestamp: bigint,
): Promise<void> {
  const clock = await ctx.banksClient.getClock();
  ctx.warpToSlot(clock.slot + 1n);
  const postWarp = await ctx.banksClient.getClock();
  ctx.setClock(
    new Clock(
      postWarp.slot,
      postWarp.epochStartTimestamp,
      postWarp.epoch,
      postWarp.leaderScheduleEpoch,
      unixTimestamp,
    ),
  );
}
