// Multi-fill cross — one taker consuming several resting orders in a single
// transaction. This is where the Solana CLOB diverges hardest from the EVM
// original, so it is worth pinning precisely.
//
// On EVM, `_match` walks the tick bitmap until gas runs out and reads makers
// straight out of a storage mapping. On Solana every account touched must be
// named up front, so the caller has to predict the exact fill sequence and
// pass one bundle per fill, in consumption order. The program re-derives and
// re-validates each bundle against live state (matching.rs::validate_fill_bundle),
// so a caller whose prediction is stale gets a hard error rather than a wrong
// fill. These tests lock that contract from both sides.
//
// Consumption order is: tick bitmap descending (find_next_down), then FIFO
// within each tick from head_index. Bundles must be supplied in that order.
//
// Covered here:
//   1. three makers at three ticks   — the bitmap walk across BookSides
//   2. three makers at one tick      — FIFO within a single BookSide
//   3. match_limit caps the fill count and the remainder rests
//   4. a stale bundle order is rejected, not mis-filled
//
// Test 3 is the one that explains the architecture: match_limit is why deep
// crosses need multi-transaction orchestration in the SDK, and why the
// `buildOrderbookBuyMultiTx` / H1 stale-maker problem exists at all.

import { describe, expect, it } from "vitest";

import { FILL_BUNDLE_LEN } from "../src/orderbook/matching-driver.js";
import { orderbookPositionPda } from "../src/pdas.js";

import { bootSmoke } from "./fixtures/setup.js";
import {
  CLOB_ERROR,
  SHARES,
  anchorProgram,
  buyTx,
  customError,
  createFundedMaker,
  fetchBookSide,
  fetchPosition,
  fillBundle,
  initMarketFeePool,
  liveAmount,
  sendTx,
} from "./fixtures/orderbook.js";

const MAKER_SIDE = 1;
const TAKER_SIDE = 0;
const TAKER_TICK = 999; // min_opp_tick = 1, so every maker tick below crosses

// Descending, because that is the order find_next_down yields them in.
const TICKS = [900, 800, 700];

describe("orderbook multi-fill cross (on-chain)", () => {
  it("fills three makers across three ticks in one transaction", async () => {
    const smoke = await bootSmoke();
    const { ctx, marketId, programs } = smoke;
    const taker = smoke.user;

    const program = anchorProgram(ctx, taker);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);

    // One maker per tick, each resting SHARES.
    const makers = [];
    for (const tick of TICKS) {
      const maker = await createFundedMaker(smoke, 10_000n);
      await sendTx(
        ctx,
        [maker],
        await buyTx(program, smoke, {
          signer: maker,
          side: MAKER_SIDE,
          tick,
          amount: SHARES,
          matchLimit: 0,
          remaining: [],
        }),
      );
      makers.push({ maker, tick });
    }

    // Bundles in bitmap-descending order: 900, 800, 700.
    const bundles = makers.flatMap(({ maker, tick }) =>
      fillBundle(smoke, MAKER_SIDE, tick, maker.publicKey),
    );
    expect(bundles).toHaveLength(3 * FILL_BUNDLE_LEN);

    await sendTx(
      ctx,
      [taker],
      await buyTx(program, smoke, {
        signer: taker,
        side: TAKER_SIDE,
        tick: TAKER_TICK,
        amount: 3n * SHARES,
        matchLimit: 3,
        remaining: bundles,
      }),
    );

    // Every maker got their leg, and every book side is drained.
    for (const { maker, tick } of makers) {
      const [positionPda] = orderbookPositionPda(
        marketId,
        maker.publicKey,
        programs,
      );
      const position = await fetchPosition(program, positionPda);
      expect(position.user.toBase58()).toBe(maker.publicKey.toBase58());
      expect(position.yesShares.toString()).toBe(SHARES.toString());

      const [bookSidePdaAddr] = [
        fillBundle(smoke, MAKER_SIDE, tick, maker.publicKey)[0]!,
      ];
      expect(liveAmount(await fetchBookSide(program, bookSidePdaAddr))).toBe(0n);
    }

    // The taker holds the sum of all three fills on the opposite leg.
    const [takerPositionPda] = orderbookPositionPda(
      marketId,
      taker.publicKey,
      programs,
    );
    const takerPosition = await fetchPosition(program, takerPositionPda);
    expect(takerPosition.noShares.toString()).toBe((3n * SHARES).toString());
  });

  it("fills three makers queued at the same tick in FIFO order", async () => {
    const smoke = await bootSmoke();
    const { ctx, marketId, programs } = smoke;
    const taker = smoke.user;
    const TICK = 900;

    const program = anchorProgram(ctx, taker);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);

    // Three makers all resting at the SAME tick — one BookSide, three entries.
    const makers = [];
    for (let i = 0; i < 3; i++) {
      const maker = await createFundedMaker(smoke, 10_000n);
      await sendTx(
        ctx,
        [maker],
        await buyTx(program, smoke, {
          signer: maker,
          side: MAKER_SIDE,
          tick: TICK,
          amount: SHARES,
          matchLimit: 0,
          remaining: [],
        }),
      );
      makers.push(maker);
    }

    const bookSideAddr = fillBundle(
      smoke,
      MAKER_SIDE,
      TICK,
      makers[0]!.publicKey,
    )[0]!;
    const before = await fetchBookSide(program, bookSideAddr);
    expect(before.orders).toHaveLength(3);
    expect(before.headIndex).toBe(0);

    // All three bundles share the same book_side account; only the maker
    // position + ATA differ. Order must match insertion order (FIFO).
    const bundles = makers.flatMap((maker) =>
      fillBundle(smoke, MAKER_SIDE, TICK, maker.publicKey),
    );

    await sendTx(
      ctx,
      [taker],
      await buyTx(program, smoke, {
        signer: taker,
        side: TAKER_SIDE,
        tick: TAKER_TICK,
        amount: 3n * SHARES,
        matchLimit: 3,
        remaining: bundles,
      }),
    );

    // head_index advanced past all three; nothing left resting.
    const after = await fetchBookSide(program, bookSideAddr);
    expect(after.headIndex).toBe(3);
    expect(liveAmount(after)).toBe(0n);

    for (const maker of makers) {
      const [positionPda] = orderbookPositionPda(
        marketId,
        maker.publicKey,
        programs,
      );
      const position = await fetchPosition(program, positionPda);
      expect(position.yesShares.toString()).toBe(SHARES.toString());
    }
  });

  it("match_limit caps fills; the unmatched remainder rests as a new order", async () => {
    const smoke = await bootSmoke();
    const { ctx, marketId, programs } = smoke;
    const taker = smoke.user;

    const program = anchorProgram(ctx, taker);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);

    const makers = [];
    for (const tick of TICKS) {
      const maker = await createFundedMaker(smoke, 10_000n);
      await sendTx(
        ctx,
        [maker],
        await buyTx(program, smoke, {
          signer: maker,
          side: MAKER_SIDE,
          tick,
          amount: SHARES,
          matchLimit: 0,
          remaining: [],
        }),
      );
      makers.push({ maker, tick });
    }

    // Supply all three bundles but allow only two fills. This is the shape a
    // single transaction is limited to in practice — the writable-account
    // budget, not match_limit, is what caps it on a real cluster.
    const bundles = makers.flatMap(({ maker, tick }) =>
      fillBundle(smoke, MAKER_SIDE, tick, maker.publicKey),
    );

    await sendTx(
      ctx,
      [taker],
      await buyTx(program, smoke, {
        signer: taker,
        side: TAKER_SIDE,
        tick: TAKER_TICK,
        amount: 3n * SHARES,
        matchLimit: 2,
        remaining: bundles,
      }),
    );

    // First two makers (ticks 900, 800) filled; the third (700) untouched.
    const [first, second, third] = makers;
    for (const { maker } of [first!, second!]) {
      const [positionPda] = orderbookPositionPda(
        marketId,
        maker.publicKey,
        programs,
      );
      const position = await fetchPosition(program, positionPda);
      expect(position.yesShares.toString()).toBe(SHARES.toString());
    }

    const [thirdPositionPda] = orderbookPositionPda(
      marketId,
      third!.maker.publicKey,
      programs,
    );
    // Never filled, so the matcher never lazily created its position.
    expect(await ctx.banksClient.getAccount(thirdPositionPda)).toBeNull();

    const thirdBookSide = fillBundle(
      smoke,
      MAKER_SIDE,
      third!.tick,
      third!.maker.publicKey,
    )[0]!;
    expect(liveAmount(await fetchBookSide(program, thirdBookSide))).toBe(SHARES);

    // The taker's unmatched third rests on its own side at TAKER_TICK.
    const takerBookSide = fillBundle(
      smoke,
      TAKER_SIDE,
      TAKER_TICK,
      taker.publicKey,
    )[0]!;
    expect(liveAmount(await fetchBookSide(program, takerBookSide))).toBe(SHARES);
  });

  it("rejects bundles supplied out of consumption order", async () => {
    const smoke = await bootSmoke();
    const { ctx } = smoke;
    const taker = smoke.user;

    const program = anchorProgram(ctx, taker);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);

    const makers = [];
    for (const tick of TICKS) {
      const maker = await createFundedMaker(smoke, 10_000n);
      await sendTx(
        ctx,
        [maker],
        await buyTx(program, smoke, {
          signer: maker,
          side: MAKER_SIDE,
          tick,
          amount: SHARES,
          matchLimit: 0,
          remaining: [],
        }),
      );
      makers.push({ maker, tick });
    }

    // Reversed: 700, 800, 900. The matcher consumes 900 first, so bundle 0
    // names the wrong BookSide and validation fails before any funds move.
    // This is the class of failure a stale off-chain prediction produces.
    const reversed = [...makers]
      .reverse()
      .flatMap(({ maker, tick }) =>
        fillBundle(smoke, MAKER_SIDE, tick, maker.publicKey),
      );

    await expect(
      sendTx(
        ctx,
        [taker],
        await buyTx(program, smoke, {
          signer: taker,
          side: TAKER_SIDE,
          tick: TAKER_TICK,
          amount: 3n * SHARES,
          matchLimit: 3,
          remaining: reversed,
        }),
      ),
    ).rejects.toThrow(customError(CLOB_ERROR.MissingCrossingBookSide));
  });
});
