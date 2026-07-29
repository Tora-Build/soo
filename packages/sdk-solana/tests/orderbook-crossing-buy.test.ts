// Crossing buy — the first test in this repo that actually executes a CLOB
// fill on-chain. Everything else in tests/ either locks instruction *shape*
// (sooth-book-builders.test.ts says so in its own header) or exercises the
// AMM path, so the matcher and `fill_order_internal` had zero runtime
// coverage.
//
// Two merge-time defects lived here undetected until this test existed:
//
//   D-1  `FILL_BUNDLE_LEN` moved 5 → 3 in matching.rs when the CPI collapse
//        removed the two reserved SystemProgram placeholders, but
//        buildFillBundles kept pushing 5. Every crossing buy failed:
//        1 fill → WrongBundleArity, 3 fills → arity passes (15 % 3 == 0) and
//        the bundles mis-slice into MissingCrossingBookSide.
//
//   D-2  `load_or_init_position` funded the OrderbookPosition PDA and then
//        wrote the discriminator without ever allocating it. A system-owned
//        account has zero-length data, so the write panicked.
//
// The maker leg is what makes this test load-bearing for D-2: a non-escrow
// resting order does NOT create the maker's OrderbookPosition (buy.rs only
// calls deposit_for_order on that path), so the account is genuinely absent
// until the taker crosses it and the matcher lazily creates it — via
// remaining_accounts, where Anchor's init_if_needed is unavailable.

import { describe, expect, it } from "vitest";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import { FILL_BUNDLE_LEN } from "../src/orderbook/matching-driver.js";
import { orderbookPositionPda } from "../src/pdas.js";

import { bootSmoke } from "./fixtures/setup.js";
import {
  CLOB_ERROR,
  SHARES,
  anchorProgram,
  buyTx,
  createFundedMaker,
  customError,
  fetchBookSide,
  fetchPosition,
  fillBundle,
  initMarketFeePool,
  liveAmount,
  sendTx,
  usdcBalance,
} from "./fixtures/orderbook.js";

const MAKER_TICK = 900;
const TAKER_TICK = 999; // MAX_TICK; min_opp_tick = 1000 - 999 = 1, so 900 crosses.
const MAKER_SIDE = 1;
const TAKER_SIDE = 0; // opposite side — this is what makes it a cross

describe("orderbook crossing buy (on-chain)", () => {
  it("taker crosses a resting maker order; both positions are created and credited", async () => {
    const smoke = await bootSmoke();
    const { ctx, marketId, programs } = smoke;

    const maker = await createFundedMaker(smoke, 10_000n);
    const taker = smoke.user;

    const program = anchorProgram(ctx, maker);
    await initMarketFeePool(ctx, program, smoke, maker);

    // ─── Maker rests an order on side 1 @ tick 900 ────────────────────────
    await sendTx(
      ctx,
      [maker],
      await buyTx(program, smoke, {
        signer: maker,
        side: MAKER_SIDE,
        tick: MAKER_TICK,
        amount: SHARES,
        matchLimit: 0,
        remaining: [],
      }),
    );

    const [makerPosition] = orderbookPositionPda(
      marketId,
      maker.publicKey,
      programs,
    );
    const [takerPosition] = orderbookPositionPda(
      marketId,
      taker.publicKey,
      programs,
    );

    // Precondition for D-2: a non-escrow resting order does not create the
    // maker's position. If this ever stops holding, the assertions below stop
    // covering the lazy-init path and must be revisited.
    expect(await ctx.banksClient.getAccount(makerPosition)).toBeNull();

    const takerUsdcBefore = await usdcBalance(ctx, taker.publicKey, smoke);

    // ─── Taker crosses it ──────────────────────────────────────────────────
    // remaining_accounts is exactly one bundle: [book_side, maker_position,
    // maker_usdc_ata]. Sending 5 here is what D-1 did.
    const bundle = fillBundle(smoke, MAKER_SIDE, MAKER_TICK, maker.publicKey);
    expect(bundle).toHaveLength(FILL_BUNDLE_LEN);

    await sendTx(
      ctx,
      [taker],
      await buyTx(program, smoke, {
        signer: taker,
        side: TAKER_SIDE,
        tick: TAKER_TICK,
        amount: SHARES,
        matchLimit: 1,
        remaining: bundle,
      }),
    );

    // ─── The fill happened ────────────────────────────────────────────────
    // Both positions now exist, are owned by sooth_core, and carry the
    // opposite legs of the trade.
    const makerPos = await fetchPosition(program, makerPosition);
    const takerPos = await fetchPosition(program, takerPosition);

    expect(makerPos.user.toBase58()).toBe(maker.publicKey.toBase58());
    expect(takerPos.user.toBase58()).toBe(taker.publicKey.toBase58());
    expect(makerPos.market.toBase58()).toBe(smoke.marketPda.toBase58());

    // taker_side = 0 credits the taker's no_shares and the maker's yes_shares
    // (the matcher credits the maker with taker_side ^ 1).
    expect(takerPos.noShares.toString()).toBe(SHARES.toString());
    expect(makerPos.yesShares.toString()).toBe(SHARES.toString());

    // The taker paid collateral for the fill.
    const takerUsdcAfter = await usdcBalance(ctx, taker.publicKey, smoke);
    expect(takerUsdcAfter).toBeLessThan(takerUsdcBefore);

    // The resting order was consumed, so the book side holds no live amount.
    expect(liveAmount(await fetchBookSide(program, bundle[0]!))).toBe(0n);
  });

  it("rejects a 5-account fill bundle with WrongBundleArity (D-1 regression)", async () => {
    const smoke = await bootSmoke();
    const { ctx } = smoke;

    const maker = await createFundedMaker(smoke, 10_000n);
    const taker = smoke.user;
    const program = anchorProgram(ctx, maker);
    await initMarketFeePool(ctx, program, smoke, maker);

    await sendTx(
      ctx,
      [maker],
      await buyTx(program, smoke, {
        signer: maker,
        side: MAKER_SIDE,
        tick: MAKER_TICK,
        amount: SHARES,
        matchLimit: 0,
        remaining: [],
      }),
    );

    // The pre-fix bundle: 3 real accounts + 2 SystemProgram placeholders.
    // 5 % 3 != 0, so the program rejects before touching any of them.
    const staleBundle: PublicKey[] = [
      ...fillBundle(smoke, MAKER_SIDE, MAKER_TICK, maker.publicKey),
      SystemProgram.programId,
      SystemProgram.programId,
    ];

    await expect(
      sendTx(
        ctx,
        [taker],
        await buyTx(program, smoke, {
          signer: taker,
          side: TAKER_SIDE,
          tick: TAKER_TICK,
          amount: SHARES,
          matchLimit: 1,
          remaining: staleBundle,
        }),
      ),
    ).rejects.toThrow(customError(CLOB_ERROR.WrongBundleArity));
  });
});
