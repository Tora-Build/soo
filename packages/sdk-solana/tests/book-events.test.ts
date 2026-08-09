// Book events, decoded from real transactions.
//
// The point of `emit_cpi!` is that the payload becomes an **inner
// instruction** rather than a program log — real transaction data that
// `getTransaction` returns, instead of a best-effort log line that RPCs
// truncate. These tests read the inner instructions the program actually
// produced, so they prove the mechanism as well as the layout.
//
// They also prove something structural: `emit_cpi!` self-invokes `sooth_core`,
// which means **a program CAN CPI into itself**. The separate `sooth_log`
// program existed because of the opposite belief, and has been deleted.

import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  BOOK_EVENT_VERSION,
  CPI_EVENT_TAG,
  decodeBookEvent,
  decodeBookEventsFromInner,
  type BookFilledEvent,
  type BookOrderCancelledEvent,
  type BookOrderPlacedEvent,
} from "../src/book/events.js";
import {
  ONE_SHARE,
  SIDE_ASK,
  SIDE_BID,
  bookPda,
  buildBookCancel,
  buildBookInit,
  buildBookPlace,
  decodeBook,
} from "../src/book/index.js";
import { bootSmoke, SOOTH_CORE_ID, type SmokeContext } from "./fixtures/setup.js";
import { anchorProgram, enableBook, initMarketFeePool } from "./fixtures/orderbook.js";
import { sendBookTx, trader } from "./fixtures/book.js";

function refs(smoke: SmokeContext) {
  return {
    marketId: smoke.marketId,
    marketPda: smoke.marketPda,
    usdcMint: smoke.usdcMint,
    programs: smoke.programs,
  };
}

async function boot(): Promise<SmokeContext> {
  const smoke = await bootSmoke();
  await initMarketFeePool(
    smoke.ctx,
    anchorProgram(smoke.ctx, smoke.creator),
    smoke,
    smoke.creator,
  );
  await sendBookTx(
    smoke,
    smoke.creator,
    buildBookInit(refs(smoke), smoke.creator.publicKey, 64),
  );
  await enableBook(smoke.ctx, smoke);
  return smoke;
}

/** Self-CPI payloads from a processed transaction, in order. */
function selfCpiPayloads(sent: { meta: any; accountKeys: PublicKey[] }) {
  const inner = sent.meta?.innerInstructions ?? [];
  return inner
    .filter((ix: any) => sent.accountKeys[ix.programIdIndex]?.equals(SOOTH_CORE_ID))
    .map((ix: any) => Buffer.from(ix.data));
}

describe("book events", () => {
  it("a resting order emits BookOrderPlaced as an inner instruction", async () => {
    const smoke = await boot();
    const maker = await trader(smoke);
    const sent = await sendBookTx(
      smoke,
      maker,
      buildBookPlace(refs(smoke), maker.publicKey, {
        side: SIDE_ASK,
        limitTick: 437,
        amount: 7n * ONE_SHARE,
        matchLimit: 0,
        postRemainder: true,
      }),
    );

    const payloads = selfCpiPayloads(sent as any);
    expect(payloads.length).toBeGreaterThan(0);

    const events = decodeBookEventsFromInner(payloads);
    expect(events).toHaveLength(1);
    const ev = events[0] as BookOrderPlacedEvent;
    expect(ev.kind).toBe("placed");
    expect(ev.version).toBe(BOOK_EVENT_VERSION);
    expect(ev.market).toBe(smoke.marketPda.toBase58());
    expect(ev.trader).toBe(maker.publicKey.toBase58());
    expect(ev.side).toBe(SIDE_ASK);
    expect(ev.priceTick).toBe(437);
    expect(ev.amount).toBe(7n * ONE_SHARE);
    expect(ev.seq).toBe(0n);
    expect(ev.ts).toBeGreaterThan(0n);
  }, 60_000);

  it("a cross emits one batched BookFilled, not one event per fill", async () => {
    // Batching matters: 20 separate inner instructions would put per-event
    // overhead into exactly the marginal cost this redesign shrinks.
    const smoke = await boot();
    const makers = [];
    for (let i = 0; i < 3; i++) {
      const m = await trader(smoke);
      makers.push(m);
      await sendBookTx(
        smoke,
        m,
        buildBookPlace(refs(smoke), m.publicKey, {
          side: SIDE_ASK,
          limitTick: 400 + i * 10,
          amount: ONE_SHARE,
          matchLimit: 0,
          postRemainder: true,
        }),
      );
    }
    const taker = await trader(smoke);
    const sent = await sendBookTx(
      smoke,
      taker,
      buildBookPlace(refs(smoke), taker.publicKey, {
        side: SIDE_BID,
        limitTick: 900,
        amount: 3n * ONE_SHARE,
        matchLimit: 8,
        postRemainder: false,
      }),
    );

    const events = decodeBookEventsFromInner(selfCpiPayloads(sent as any));
    expect(events).toHaveLength(1);
    const ev = events[0] as BookFilledEvent;
    expect(ev.kind).toBe("filled");
    expect(ev.taker).toBe(taker.publicKey.toBase58());
    expect(ev.takerSide).toBe(SIDE_BID);
    expect(ev.fills).toHaveLength(3);

    // Consumption order is best price first.
    expect(ev.fills.map((f) => f.priceTick)).toEqual([400, 410, 420]);
    expect(ev.fills.map((f) => f.maker)).toEqual(
      makers.map((m) => m.publicKey.toBase58()),
    );
    for (const f of ev.fills) expect(f.amount).toBe(ONE_SHARE);
    // Fee is on the executed price, so it is non-zero but small.
    expect(ev.fee).toBeGreaterThan(0n);
  }, 120_000);

  it("the execution price in the event is the maker's, not the taker's limit", async () => {
    // If this ever reports the taker's limit, every downstream price chart and
    // P&L calculation is wrong in the taker's favour.
    const smoke = await boot();
    const maker = await trader(smoke);
    await sendBookTx(
      smoke,
      maker,
      buildBookPlace(refs(smoke), maker.publicKey, {
        side: SIDE_ASK,
        limitTick: 250,
        amount: ONE_SHARE,
        matchLimit: 0,
        postRemainder: true,
      }),
    );
    const taker = await trader(smoke);
    const sent = await sendBookTx(
      smoke,
      taker,
      buildBookPlace(refs(smoke), taker.publicKey, {
        side: SIDE_BID,
        limitTick: 950,
        amount: ONE_SHARE,
        matchLimit: 4,
        postRemainder: false,
      }),
    );
    const ev = decodeBookEventsFromInner(
      selfCpiPayloads(sent as any),
    )[0] as BookFilledEvent;
    expect(ev.fills[0]!.priceTick).toBe(250);
  }, 60_000);

  it("a partial cross emits both the fill batch and the resting remainder", async () => {
    const smoke = await boot();
    const maker = await trader(smoke);
    await sendBookTx(
      smoke,
      maker,
      buildBookPlace(refs(smoke), maker.publicKey, {
        side: SIDE_ASK,
        limitTick: 400,
        amount: ONE_SHARE,
        matchLimit: 0,
        postRemainder: true,
      }),
    );
    const taker = await trader(smoke);
    const sent = await sendBookTx(
      smoke,
      taker,
      buildBookPlace(refs(smoke), taker.publicKey, {
        side: SIDE_BID,
        limitTick: 900,
        amount: 3n * ONE_SHARE,
        matchLimit: 8,
        postRemainder: true,
      }),
    );
    const events = decodeBookEventsFromInner(selfCpiPayloads(sent as any));
    expect(events.map((e) => e.kind)).toEqual(["filled", "placed"]);
    const placed = events[1] as BookOrderPlacedEvent;
    expect(placed.amount).toBe(2n * ONE_SHARE);

    // And the seq in the event is the one book_cancel takes.
    const [pda] = bookPda(smoke.marketId, smoke.programs);
    const acct = await smoke.ctx.banksClient.getAccount(pda);
    expect(decodeBook(Buffer.from(acct!.data)).bids[0]!.seq).toBe(placed.seq);
  }, 60_000);

  it("cancel emits BookOrderCancelled with the refund", async () => {
    const smoke = await boot();
    const maker = await trader(smoke);
    await sendBookTx(
      smoke,
      maker,
      buildBookPlace(refs(smoke), maker.publicKey, {
        side: SIDE_ASK,
        limitTick: 400,
        amount: 10n * ONE_SHARE,
        matchLimit: 0,
        postRemainder: true,
      }),
    );
    const sent = await sendBookTx(
      smoke,
      maker,
      buildBookCancel(refs(smoke), maker.publicKey, 0n),
    );
    const ev = decodeBookEventsFromInner(
      selfCpiPayloads(sent as any),
    )[0] as BookOrderCancelledEvent;
    expect(ev.kind).toBe("cancelled");
    expect(ev.seq).toBe(0n);
    expect(ev.trader).toBe(maker.publicKey.toBase58());
    // An ask at 0.40 escrows 0.60/share.
    expect(ev.refund).toBe(6n * ONE_SHARE);
  }, 60_000);
});

describe("cross-package decoder agreement", () => {
  it("decodes the same captured bytes as sooth-data's independent decoder", async () => {
    // `sooth-data` ships its OWN decoder for this wire format, because the
    // indexer deliberately has no SDK dependency. Two decoders of one format
    // can drift, and the failure would be silent — an indexer quietly serving
    // different numbers than the client.
    //
    // Both are pinned to this single captured artifact rather than to each
    // other, so neither can drift without one of them failing.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const path = join(
      import.meta.dirname,
      "..",
      "..",
      "sooth-data",
      "test",
      "fixtures",
      "bookfilled.bin",
    );
    const bytes = new Uint8Array(await readFile(path));

    const ev = decodeBookEvent(bytes) as BookFilledEvent;
    expect(ev).not.toBeNull();
    expect(ev.kind).toBe("filled");
    expect(ev.version).toBe(BOOK_EVENT_VERSION);
    // The values sooth-data's test asserts on the same file.
    expect(ev.fills).toHaveLength(2);
    expect(ev.fills.map((f) => f.priceTick)).toEqual([400, 410]);
    for (const f of ev.fills) expect(f.amount).toBe(ONE_SHARE);
    expect(ev.fee).toBeGreaterThan(0n);
    expect(ev.ts).toBeGreaterThan(0n);
  });
});

describe("book event decoder — hostile input", () => {
  it("returns null for something that is not a book event", () => {
    // Quiet skip, so an unrelated inner instruction does not break an indexer.
    expect(decodeBookEvent(Buffer.alloc(4))).toBeNull();
    expect(decodeBookEvent(Buffer.alloc(64))).toBeNull();
    const wrongDisc = Buffer.concat([CPI_EVENT_TAG, Buffer.alloc(64)]);
    expect(decodeBookEvent(wrongDisc)).toBeNull();
  });

  it("throws on an unknown version rather than mis-parsing it", async () => {
    // The failure mode the current book has no defence against. A v2 event read
    // by a v1 decoder yields plausible garbage; rejecting is the only safe
    // response.
    const smoke = await boot();
    const maker = await trader(smoke);
    const sent = await sendBookTx(
      smoke,
      maker,
      buildBookPlace(refs(smoke), maker.publicKey, {
        side: SIDE_BID,
        limitTick: 500,
        amount: ONE_SHARE,
        matchLimit: 0,
        postRemainder: true,
      }),
    );
    const payload = selfCpiPayloads(sent as any)[0]!;
    expect(decodeBookEvent(payload)).not.toBeNull();

    const bumped = Buffer.from(payload);
    bumped.writeUInt8(2, 16); // version byte, first field of the body
    expect(() => decodeBookEvent(bumped)).toThrow(/unsupported event version 2/);
  }, 60_000);

  it("throws on trailing bytes rather than silently truncating", async () => {
    const smoke = await boot();
    const maker = await trader(smoke);
    const sent = await sendBookTx(
      smoke,
      maker,
      buildBookPlace(refs(smoke), maker.publicKey, {
        side: SIDE_BID,
        limitTick: 500,
        amount: ONE_SHARE,
        matchLimit: 0,
        postRemainder: true,
      }),
    );
    const payload = selfCpiPayloads(sent as any)[0]!;
    const extended = Buffer.concat([payload, Buffer.alloc(3)]);
    expect(() => decodeBookEvent(extended)).toThrow(/trailing bytes/);
  }, 60_000);
});
