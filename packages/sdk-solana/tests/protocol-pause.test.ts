// Protocol circuit-breaker (D-3).
//
// `pause`/`unpause` and the `ProtocolConfig.paused` flag shipped with the 5→1
// merge, but only `create_market` ever consulted the flag. The error message
// claimed "all state-mutating instructions are disabled" while `buy`,
// `trade_positions`, `sell_positions`, `seed_lp`, `cancel`, `redeem*` and
// every other handler ignored it — so pausing halted market creation and
// nothing else. That is worse than having no breaker, because an operator
// would believe trading had stopped.
//
// Scope is now a TRADING halt, deliberately not a total freeze (see
// require_not_paused in state/protocol_config.rs):
//
//   gated      buy, trade_positions, sell_positions, seed_lp, create_market
//   ungated    cancel, redeem*, claim*, merge*, resolution/admin, fee cranks
//
// Exits stay open on purpose. A breaker that traps user funds is its own
// failure mode, and a maker must always be able to pull a resting order.

import { describe, expect, it } from "vitest";

import { bootSmoke } from "./fixtures/setup.js";
import {
  CLOB_ERROR,
  SHARES,
  anchorProgram,
  buyTx,
  cancelTx,
  customError,
  fetchBookSide,
  fillBundle,
  initMarketFeePool,
  liveAmount,
  sendTx,
  setPaused,
} from "./fixtures/orderbook.js";

const SIDE = 1;
const TICK = 900;

describe("protocol pause (circuit-breaker)", () => {
  it("blocks a CLOB buy while paused, and allows it again after unpause", async () => {
    const smoke = await bootSmoke();
    const { ctx, creator } = smoke;
    const user = smoke.user;
    const program = anchorProgram(ctx, user);
    await initMarketFeePool(ctx, program, smoke, creator);

    const order = () =>
      buyTx(program, smoke, {
        signer: user,
        side: SIDE,
        tick: TICK,
        amount: SHARES,
        matchLimit: 0,
        remaining: [],
      });

    await setPaused(ctx, program, smoke, creator, true);
    await expect(sendTx(ctx, [user], await order())).rejects.toThrow(
      customError(CLOB_ERROR.ProtocolPaused),
    );

    await setPaused(ctx, program, smoke, creator, false);
    await sendTx(ctx, [user], await order());

    const bookSide = fillBundle(smoke, SIDE, TICK, user.publicKey)[0]!;
    expect(liveAmount(await fetchBookSide(program, bookSide))).toBe(SHARES);
  });

  it("blocks an AMM trade while paused", async () => {
    const smoke = await bootSmoke();
    const { ctx, creator } = smoke;
    const program = anchorProgram(ctx, creator);

    await setPaused(ctx, program, smoke, creator, true);

    // trade_positions is reached through the adapter in normal use; here we
    // only need to prove the guard fires, so any well-formed call suffices.
    // A paused protocol must reject before argument validation.
    const { SolanaChainAdapter } = await import("../src/adapter.js");
    const { LiteSvmConnection } = await import(
      "./fixtures/svm.js"
    );
    const conn = new LiteSvmConnection(ctx);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "pause",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      usdcMint: smoke.usdcMint,
      connection: conn,
    });
    const { encodePubkeyRef } = await import("../src/refs.js");
    const req = await adapter.buildTrade(encodePubkeyRef(smoke.marketPda), {
      outcome: 1,
      deltaShares: 1_000_000_000_000_000n,
      maxCostWad: 10_000_000_000_000_000_000n,
      user: encodePubkeyRef(smoke.user.publicKey),
    } as never);

    const { Transaction } = await import("@solana/web3.js");
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

    await expect(adapter.submit(req, signer)).rejects.toThrow(
      /code=6054|ProtocolPaused/i,
    );
  });

  it("still allows cancel while paused — exits must not be trapped", async () => {
    const smoke = await bootSmoke();
    const { ctx, creator } = smoke;
    const user = smoke.user;
    const program = anchorProgram(ctx, user);
    await initMarketFeePool(ctx, program, smoke, creator);

    // Rest an order before the halt.
    await sendTx(
      ctx,
      [user],
      await buyTx(program, smoke, {
        signer: user,
        side: SIDE,
        tick: TICK,
        amount: SHARES,
        matchLimit: 0,
        remaining: [],
      }),
    );

    await setPaused(ctx, program, smoke, creator, true);

    // The maker can still withdraw it.
    await sendTx(ctx, [user], await cancelTx(program, smoke, user, SIDE, TICK));

    const bookSide = fillBundle(smoke, SIDE, TICK, user.publicKey)[0]!;
    expect(liveAmount(await fetchBookSide(program, bookSide))).toBe(0n);
  });
});
