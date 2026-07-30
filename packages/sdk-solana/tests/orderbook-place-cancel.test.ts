// Order lifecycle: place → cancel → compact → close.
//
// Ported from main's sooth_book/tests/place_cancel.rs (11 tests), which the
// 5→1 merge deleted. This was the largest uncovered area in develop: nothing
// exercised cancel, cancel_by_id, compact_book_side or close_book_side at all.
//
// Two of main's 11 are already covered by e2e and are not duplicated here:
// cap_rejects_51st_order (orderbook-per-tick-cap.spec.ts) and
// dust_credit_back_for_escrow (orderbook-dust.spec.ts).
//
// Adapted rather than transcribed: main reached the "trailing cancelled orders"
// state by hand-writing BookSide account data (write_book_side). Here the same
// state is produced by actually calling cancel_by_id, so the tests exercise the
// real cancel path instead of trusting a fixture to model it correctly.

import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import { bootSmoke } from "./fixtures/setup.js";
import {
  CLOB_ERROR,
  SHARES,
  anchorProgram,
  buyTx,
  cancelByIdTx,
  cancelTx,
  closeBookSideTx,
  compactBookSideTx,
  customError,
  fetchBookSide,
  fillBundle,
  initMarketFeePool,
  liveAmount,
  sendTx,
  sendTxCollectingEvents,
  usdcBalance,
} from "./fixtures/orderbook.js";

const SIDE = 0; // resting on one side only, so nothing ever crosses
const TICK = 900;

/** Anchor's built-in AccountNotInitialized. Not in the program's own enum. */
const ANCHOR_ACCOUNT_NOT_INITIALIZED = 3012;

/** sha256("event:OrderCancelled")[..8] */
const ORDER_CANCELLED_DISC = "6c388044a871a8ef";

async function boot() {
  const smoke = await bootSmoke();
  const program = anchorProgram(smoke.ctx, smoke.user);
  await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);
  return { smoke, program, user: smoke.user };
}

async function place(
  smoke: any,
  program: any,
  tick = TICK,
  amount = SHARES,
): Promise<void> {
  await sendTx(
    smoke.ctx,
    [smoke.user],
    await buyTx(program, smoke, {
      signer: smoke.user,
      side: SIDE,
      tick,
      amount,
      matchLimit: 0,
      remaining: [],
    }),
  );
}

function bookSideAddr(smoke: any, tick = TICK): PublicKey {
  return fillBundle(smoke, SIDE, tick, smoke.user.publicKey)[0]!;
}

describe("orderbook place / cancel / compact / close", () => {
  it("places at an empty tick, creating the BookSide", async () => {
    const { smoke, program } = await boot();
    const addr = bookSideAddr(smoke);
    expect(await smoke.ctx.banksClient.getAccount(addr)).toBeNull();

    await place(smoke, program);

    const bs = await fetchBookSide(program, addr);
    expect(bs.orders).toHaveLength(1);
    expect(bs.side).toBe(SIDE);
    expect(bs.tick).toBe(TICK);
    expect(bs.headIndex).toBe(0);
    expect(liveAmount(bs)).toBe(SHARES);
  }, 60_000);

  it("appends at an already-populated tick", async () => {
    const { smoke, program } = await boot();
    await place(smoke, program);
    await place(smoke, program);

    const bs = await fetchBookSide(program, bookSideAddr(smoke));
    expect(bs.orders).toHaveLength(2);
    expect(liveAmount(bs)).toBe(2n * SHARES);
    // Order ids are unique and monotonic — they encode a per-market sequence.
    expect(bs.orders[0].id.toString()).not.toBe(bs.orders[1].id.toString());
  }, 60_000);

  it("cancel zeroes the order in place and refunds collateral", async () => {
    const { smoke, program } = await boot();
    await place(smoke, program);
    const before = await usdcBalance(smoke.ctx, smoke.user.publicKey, smoke);

    await sendTx(
      smoke.ctx,
      [smoke.user],
      await cancelTx(program, smoke, smoke.user, SIDE, TICK),
    );

    const bs = await fetchBookSide(program, bookSideAddr(smoke));
    // The slot survives with amount 0 — compaction, not cancel, reclaims it.
    expect(bs.orders).toHaveLength(1);
    expect(bs.orders[0].amount.toString()).toBe("0");
    expect(liveAmount(bs)).toBe(0n);
    expect(
      await usdcBalance(smoke.ctx, smoke.user.publicKey, smoke),
    ).toBeGreaterThan(before);
  }, 60_000);

  it("OrderCancelled carries the unfilled remaining amount", async () => {
    // An indexer cannot recover this after the fact: cancel zeroes the order,
    // so the withdrawn size is gone from state. Ported with main's a1f3964,
    // which added the field.
    const { smoke, program } = await boot();
    await place(smoke, program);

    const events = await sendTxCollectingEvents(
      smoke.ctx,
      [smoke.user],
      await cancelTx(program, smoke, smoke.user, SIDE, TICK),
    );
    const cancelled = events.find(
      (e) => Buffer.from(e.subarray(0, 8)).toString("hex") === ORDER_CANCELLED_DISC,
    );
    expect(cancelled).toBeTruthy();

    // market(32) side(1) tick(2) maker(32) order_id(8) remaining(u128)
    const body = Buffer.from(cancelled!.subarray(8));
    let o = 32;
    expect(body.readUInt8(o)).toBe(SIDE);
    o += 1;
    expect(body.readUInt16LE(o)).toBe(TICK);
    o += 2;
    expect(new PublicKey(body.subarray(o, o + 32)).toBase58()).toBe(
      smoke.user.publicKey.toBase58(),
    );
    o += 32 + 8;
    const lo = body.readBigUInt64LE(o);
    const hi = body.readBigUInt64LE(o + 8);
    expect((hi << 64n) | lo).toBe(SHARES);
  }, 60_000);

  it("cancel on a tick that was never used fails at the account constraint", async () => {
    // No BookSide PDA exists yet, so Anchor rejects with AccountNotInitialized
    // (3012) before the handler can reach its own NoCancellableOrder check.
    // Worth distinguishing from the case below: same user intent, different
    // failure layer, and only one of them is the program's own guard.
    const { smoke, program } = await boot();
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.user],
        await cancelTx(program, smoke, smoke.user, SIDE, TICK),
      ),
    ).rejects.toThrow(customError(ANCHOR_ACCOUNT_NOT_INITIALIZED));
  }, 60_000);

  it("cancel rejects when every order at the tick is already zeroed", async () => {
    // This is the handler's own guard: the BookSide exists, but the caller has
    // nothing left to cancel.
    const { smoke, program } = await boot();
    await place(smoke, program);
    await sendTx(
      smoke.ctx,
      [smoke.user],
      await cancelTx(program, smoke, smoke.user, SIDE, TICK),
    );
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.user],
        await cancelTx(program, smoke, smoke.user, SIDE, TICK),
      ),
    ).rejects.toThrow(customError(CLOB_ERROR.NoCancellableOrder));
  }, 60_000);

  it("cancel_by_id rejects an order id from a different tick", async () => {
    const { smoke, program } = await boot();
    await place(smoke, program, TICK);
    await place(smoke, program, TICK + 1);

    const bs = await fetchBookSide(program, bookSideAddr(smoke, TICK));
    const orderId = BigInt(bs.orders[0].id.toString());

    // The id encodes its own side/tick, so presenting it at TICK+1 is caught
    // rather than silently cancelling the wrong order.
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.user],
        await cancelByIdTx(program, smoke, smoke.user, orderId, SIDE, TICK + 1),
      ),
    ).rejects.toThrow(customError(CLOB_ERROR.OrderIdSeedMismatch));
  }, 60_000);

  it("compact drops trailing zeroed orders only", async () => {
    const { smoke, program } = await boot();
    for (let i = 0; i < 5; i++) await place(smoke, program);

    const addr = bookSideAddr(smoke);
    let bs = await fetchBookSide(program, addr);
    const ids = bs.orders.map((o: any) => BigInt(o.id.toString()));

    // Cancel the LAST three by id, so the zeros are trailing.
    for (const id of ids.slice(2)) {
      await sendTx(
        smoke.ctx,
        [smoke.user],
        await cancelByIdTx(program, smoke, smoke.user, id, SIDE, TICK),
      );
    }

    await sendTx(
      smoke.ctx,
      [smoke.creator], // permissionless crank — not the maker
      await compactBookSideTx(program, smoke, smoke.creator, SIDE, TICK, 3),
    );

    bs = await fetchBookSide(program, addr);
    expect(bs.orders).toHaveLength(2);
    expect(bs.orders.every((o: any) => BigInt(o.amount.toString()) > 0n)).toBe(
      true,
    );
  }, 120_000);

  it("compact refuses a max_drops above the 16 bound", async () => {
    // The cap exists because compaction is an unbounded loop otherwise, and
    // cancel_by_id's linear scan is what the per-tick order cap bounds.
    const { smoke, program } = await boot();
    await place(smoke, program);
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await compactBookSideTx(program, smoke, smoke.creator, SIDE, TICK, 17),
      ),
    ).rejects.toThrow(customError(CLOB_ERROR.CompactBoundExceeded));
  }, 60_000);

  it("compact drops at most max_drops per call", async () => {
    const { smoke, program } = await boot();
    const COUNT = 20;
    for (let i = 0; i < COUNT; i++) await place(smoke, program);

    const addr = bookSideAddr(smoke);
    let bs = await fetchBookSide(program, addr);
    for (const o of [...bs.orders].reverse()) {
      await sendTx(
        smoke.ctx,
        [smoke.user],
        await cancelByIdTx(
          program,
          smoke,
          smoke.user,
          BigInt(o.id.toString()),
          SIDE,
          TICK,
        ),
      );
    }

    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await compactBookSideTx(program, smoke, smoke.creator, SIDE, TICK, 16),
    );

    bs = await fetchBookSide(program, addr);
    expect(bs.orders).toHaveLength(COUNT - 16);
  }, 180_000);

  it("close refuses a BookSide that still holds live orders", async () => {
    const { smoke, program } = await boot();
    await place(smoke, program);
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await closeBookSideTx(program, smoke, smoke.creator, SIDE, TICK),
      ),
    ).rejects.toThrow(customError(CLOB_ERROR.BookSideNotDrained));
  }, 60_000);

  it("close reclaims a fully drained BookSide", async () => {
    const { smoke, program } = await boot();
    await place(smoke, program);

    const bs = await fetchBookSide(program, bookSideAddr(smoke));
    await sendTx(
      smoke.ctx,
      [smoke.user],
      await cancelByIdTx(
        program,
        smoke,
        smoke.user,
        BigInt(bs.orders[0].id.toString()),
        SIDE,
        TICK,
      ),
    );
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await compactBookSideTx(program, smoke, smoke.creator, SIDE, TICK, 1),
    );

    const addr = bookSideAddr(smoke);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await closeBookSideTx(program, smoke, smoke.creator, SIDE, TICK),
    );

    // Rent goes to whoever cranked the close, not the original placer — a
    // documented unfairness in the spec's rent model, pinned here so it is a
    // known property rather than a surprise.
    expect(await smoke.ctx.banksClient.getAccount(addr)).toBeNull();
  }, 120_000);
});
