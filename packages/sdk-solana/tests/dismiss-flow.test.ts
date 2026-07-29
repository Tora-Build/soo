import { describe, expect, it } from "vitest";
import { Clock } from "./fixtures/svm.js";
import { Transaction } from "@solana/web3.js";

import { SolanaChainAdapter } from "../src/adapter.js";
import { WAD } from "../src/math/lmsr.js";
import { encodePubkeyRef } from "../src/refs.js";

import { LiteSvmConnection } from "./fixtures/svm.js";
import { bootSmoke } from "./fixtures/setup.js";

describe("dismiss market flow", () => {
  it("creator can dismiss after trial_end_at", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new LiteSvmConnection(smoke.ctx);
    const adapter = buildAdapter(smoke, conn, "dismiss-flow");

    const marketRef = encodePubkeyRef(smoke.marketPda);
    const creatorRef = encodePubkeyRef(smoke.creator.publicKey);

    const pre = await conn.getAccountInfo(smoke.ammStatePda);
    expect(pre).not.toBeNull();
    const trialEndAt = pre!.data.readBigInt64LE(136);
    expect(pre!.data[145]).toBe(0);

    await warpClock(smoke.ctx, trialEndAt + 1n);

    const req = await adapter.buildDismissMarket(marketRef, {
      user: creatorRef,
    });
    expect(req.kind).toBe("trade");
    expect((req.meta as { operation?: string }).operation).toBe(
      "dismissMarket",
    );

    const receipt = await adapter.submit(req, signer(smoke.creator));
    expect(receipt.txId.startsWith("sol:")).toBe(true);

    const post = await conn.getAccountInfo(smoke.ammStatePda);
    expect(post).not.toBeNull();
    expect(post!.data[145]).toBe(1);
  }, 60_000);

  it("pre-trial dismiss rejects with TrialNotExpired", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new LiteSvmConnection(smoke.ctx);
    const adapter = buildAdapter(smoke, conn, "dismiss-pretrial");

    const req = await adapter.buildDismissMarket(
      encodePubkeyRef(smoke.marketPda),
      {
        user: encodePubkeyRef(smoke.creator.publicKey),
      },
    );

    await expect(adapter.submit(req, signer(smoke.creator))).rejects.toMatchObject({
      kind: "TrialNotExpired",
    });
  }, 60_000);
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

function signer(kp: Awaited<ReturnType<typeof bootSmoke>>["creator"]) {
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
