// The 256 KB allocator's caller contract.
//
// sooth_core installs a custom #[global_allocator] over a 256 KB region
// (lib.rs). The Solana runtime only maps that region when a transaction sends
// `ComputeBudgetProgram.requestHeapFrame`, and the allocator hands out
// addresses from the TOP of it — so a transaction that omits the frame faults
// on its FIRST allocation with "Access violation in heap section".
//
// Two properties matter and neither is obvious from reading the program:
//
//   1. The requirement is program-wide, not orderbook-specific: `sooth_core`
//      is one program, so `create_market`, `redeem` and every other
//      instruction share the one allocator.
//
//   2. There is no way to detect a missing frame at runtime. The mapped heap
//      size is not queryable, so the program cannot fail with a friendly
//      error; it aborts. That makes this a contract the SDK must uphold on
//      every path, and therefore something worth pinning in a test rather
//      than a comment.
//
// These tests are the guardrail: if someone drops the frame from a transaction
// builder, the first one fails; if someone removes the allocator without
// removing the frame, the second one fails.

import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
} from "@solana/web3.js";

import { soothCoreIdl } from "../src/anchor/index.js";
import { bootSmoke } from "./fixtures/setup.js";
import {
  CapturingConnection,
  mockSubmitAdapter,
} from "./fixtures/mock-submit.js";
import {
  SOOTH_CORE_HEAP_BYTES,
  SHARES,
  anchorProgram,
  enableBook,
  initMarketFeePool,
  sendTx,
} from "./fixtures/orderbook.js";
import {
  ONE_SHARE,
  SIDE_ASK,
  SIDE_BID,
  bookInitIx,
  bookGrowIx,
  bookPlaceIx,
  sendBookTx,
  sendBookTxRaw,
  trader,
} from "./fixtures/book.js";

/** A market with an initialised book, ready to take an order. */
async function boot() {
  const smoke = await bootSmoke();
  await initMarketFeePool(
    smoke.ctx,
    anchorProgram(smoke.ctx, smoke.creator),
    smoke,
    smoke.creator,
  );
  await sendBookTx(smoke, smoke.creator, bookInitIx(smoke, smoke.creator.publicKey, 32));
  await enableBook(smoke.ctx, smoke);
  return smoke;
}

describe("256 KB allocator caller contract", () => {
  it("a transaction without the heap frame faults on first allocation", async () => {
    const smoke = await boot();
    const user = await trader(smoke);

    // Same instruction that succeeds below — the ONLY difference is the
    // missing compute-budget preamble.
    //
    // Match only "Access violation": the suffix differs by runtime version.
    // LiteSVM and solana-test-validator say "in heap section at address
    // 0x30003ff68 of size 8"; live devnet says "writing 8 bytes at address
    // 0x30003ff68 (in unallocated ...)". Same fault, and pinning the full
    // LiteSVM phrasing would make this test lie about devnet.
    await expect(
      sendBookTxRaw(
        smoke,
        user,
        { skipHeapFrame: true },
        bookPlaceIx(smoke, user.publicKey, SIDE_BID, 400, 5n * ONE_SHARE, 8, true),
      ),
    ).rejects.toThrow(/Access violation/);
  });

  it("the same order succeeds with the frame", async () => {
    const smoke = await boot();
    const user = await trader(smoke);
    await sendBookTx(
      smoke,
      user,
      bookPlaceIx(smoke, user.publicKey, SIDE_BID, 400, 5n * ONE_SHARE, 8, true),
    );
  });

  it("submit() puts the frame on the wire, at the full 256 KB", async () => {
    // The builders return a bare instruction — `submit` is what assembles the
    // transaction, so this is the only place the contract can be upheld. Read
    // it off the SERIALIZED bytes rather than the adapter source: a test that
    // greps for `requestHeapFrame` passes on a mention in a comment.
    const conn = new CapturingConnection();
    const { adapter, req, signer } = mockSubmitAdapter(conn);

    await adapter.submit(req, signer);

    const tx = Transaction.from(Buffer.from(conn.rawTransactions[0]!));
    const budget = tx.instructions.filter((ix) =>
      ix.programId.equals(ComputeBudgetProgram.programId),
    );
    // RequestHeapFrame is compute-budget instruction 1; its arg is a u32 LE.
    const frame = budget.find((ix) => ix.data[0] === 1);
    expect(frame, "submit() built a transaction with no heap frame").toBeTruthy();
    expect(Buffer.from(frame!.data).readUInt32LE(1)).toBe(SOOTH_CORE_HEAP_BYTES);

    // The frame has to precede the sooth_core instruction it protects: the
    // runtime maps the heap when it processes the request, and the allocator
    // faults on the first allocation of anything that ran before it.
    const frameIndex = tx.instructions.indexOf(frame!);
    const coreIndex = tx.instructions.findIndex((ix) =>
      ix.programId.equals(new PublicKey(soothCoreIdl.address)),
    );
    expect(coreIndex).toBeGreaterThan(-1);
    expect(frameIndex).toBeLessThan(coreIndex);
  });

  it("the largest book_place that can succeed still fits the frame", async () => {
    // The number the 256 KB frame is actually sized against.
    //
    // Measured against the built artifact by reading the allocator's cursor:
    // `book_place` costs ~2.5 KB fixed + ~516 B per fill, and 203 fills is
    // the most that can succeed at all — at 204 the batched `BookFilled`
    // event exceeds the 10,240-byte CPI instruction-data limit. So this is
    // the worst case a real user can reach: ~107 KB of the 256 KB frame.
    //
    // A guard, not a measurement: if per-fill allocation grew ~2.4x, this
    // stops passing rather than failing in production with an allocator
    // abort. It rests ~150 orders, so it is slow by design.
    const FILLS = 200;
    const smoke = await bootSmoke();
    await initMarketFeePool(
      smoke.ctx,
      anchorProgram(smoke.ctx, smoke.creator),
      smoke,
      smoke.creator,
    );
    await sendBookTx(smoke, smoke.creator, bookInitIx(smoke, smoke.creator.publicKey, 150));
    // Two blocks per resting maker — their order and their seat — plus the
    // taker's.
    for (let g = 0; g < 40; g++) {
      try {
        await sendBookTx(
          smoke,
          smoke.creator,
          bookGrowIx(smoke, smoke.creator.publicKey, FILLS * 2 + 16),
        );
      } catch {
        break;
      }
    }
    await enableBook(smoke.ctx, smoke);

    for (let i = 0; i < FILLS; i++) {
      const maker = await trader(smoke);
      await sendBookTx(
        smoke,
        maker,
        bookPlaceIx(smoke, maker.publicKey, SIDE_ASK, 400 + (i % 500), ONE_SHARE, 0, true),
      );
    }

    const taker = await trader(smoke);
    await sendBookTx(
      smoke,
      taker,
      bookPlaceIx(
        smoke,
        taker.publicKey,
        SIDE_BID,
        990,
        BigInt(FILLS) * ONE_SHARE,
        FILLS + 2,
        false,
      ),
    );
  }, 600_000);
});
