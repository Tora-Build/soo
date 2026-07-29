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
//   1. The requirement is program-wide, not orderbook-specific. Because the
//      5→1 merge produced a single program, `create_market`, `redeem`, and
//      every other instruction share the allocator. main did not have this
//      problem — its allocator was scoped to sooth_book alone.
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

import { bootSmoke } from "./fixtures/setup.js";
import {
  SOOTH_CORE_HEAP_BYTES,
  SHARES,
  anchorProgram,
  buyTx,
  initMarketFeePool,
  sendTx,
} from "./fixtures/orderbook.js";

describe("256 KB allocator caller contract", () => {
  it("a transaction without the heap frame faults on first allocation", async () => {
    const smoke = await bootSmoke();
    const { ctx } = smoke;
    const user = smoke.user;
    const program = anchorProgram(ctx, user);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);

    const order = await buyTx(program, smoke, {
      signer: user,
      side: 1,
      tick: 900,
      amount: SHARES,
      matchLimit: 0,
      remaining: [],
    });

    // Same instruction that succeeds elsewhere in the suite — the ONLY
    // difference is the missing compute-budget preamble.
    // Match only "Access violation" — the suffix differs by runtime version.
    // LiteSVM and solana-test-validator say "in heap section at address
    // 0x30003ff68 of size 8"; live devnet says "writing 8 bytes at address
    // 0x30003ff68 (in unallocated ...)". Both are the same fault, and pinning
    // the full LiteSVM phrasing would have made this test lie about devnet.
    await expect(
      sendTx(ctx, [user], order, { skipHeapFrame: true }),
    ).rejects.toThrow(/Access violation/);
  });

  it("the same order succeeds with the frame", async () => {
    const smoke = await bootSmoke();
    const { ctx } = smoke;
    const user = smoke.user;
    const program = anchorProgram(ctx, user);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);

    // sendTx prepends the frame by default, as the SDK adapter does.
    await sendTx(
      ctx,
      [user],
      await buyTx(program, smoke, {
        signer: user,
        side: 1,
        tick: 900,
        amount: SHARES,
        matchLimit: 0,
        remaining: [],
      }),
    );
  });

  it("the SDK adapter requests the frame on every path it builds", async () => {
    // Cheap structural check against the shipped source. The adapter has three
    // transaction-assembly sites (trade, orderbook, generic submit); all three
    // must carry the frame or some user flow faults in production while the
    // fixtures — which prepend it themselves — stay green.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const adapterPath = fileURLToPath(
      new URL("../src/adapter.ts", import.meta.url),
    );
    const src = readFileSync(adapterPath, "utf8");

    const frames = src.match(/requestHeapFrame/g) ?? [];
    const limits = src.match(/setComputeUnitLimit/g) ?? [];
    expect(frames.length).toBe(limits.length);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(src).toContain(`bytes: ${SOOTH_CORE_HEAP_BYTES}`);
  });
});
