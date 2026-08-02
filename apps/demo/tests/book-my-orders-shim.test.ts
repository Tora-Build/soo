// The chain-shim read behind "my open orders".
//
// The legacy hook answers this question by replaying OrderPlaced /
// OrderCancelled / OrdersFilled over a chunked getLogs scan and netting the
// three per price level. Against the redesigned book that scan finds nothing —
// the new program emits a different event set — so the panel renders empty no
// matter how many orders are actually resting. That is the bug this read
// exists to remove.
//
// Two properties matter beyond "it returns rows":
//
//   1. Every row carries its REAL `seq`, because that is what `book_cancel`
//      takes. The legacy path could only produce a level, hence the
//      synthesised `${side}:${tick}` id and the regex that parsed it back.
//   2. Other traders' orders never leak in. The book is one shared account, so
//      unlike the legacy per-user PDA there is no structural guarantee here —
//      only the filter.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookSnapshot } from "@sooth/sdk-solana";

import {
  __resetBookCache,
  dispatchAmmRead,
} from "../src/lib/chain-shim/amm-bridge";
import { parseOrderId } from "../src/lib/orderbook-math";

const MARKET = "sol:BtWVTobCWpViPPVpfaz7osbLpeMYjGNw3kNvdFiWE4qJ";
const ALICE = "Ai1ce11111111111111111111111111111111111111";
const BOB = "Bob11111111111111111111111111111111111111111";
const ONE_SHARE = 1_000_000n;

let seq = 0n;
function order(trader: string, priceTick: number, shares: number, side: number) {
  return {
    index: Number(seq),
    seq: seq++,
    trader,
    priceTick,
    side,
    amount: BigInt(shares) * ONE_SHARE,
  };
}

function snapshot(partial: Partial<BookSnapshot> = {}): BookSnapshot {
  return {
    market: MARKET.replace("sol:", ""),
    nextSeq: 99n,
    orderCount: 0,
    blockCount: 9,
    capacity: 64,
    bids: [],
    asks: [],
    seats: [],
    ...partial,
  } as BookSnapshot;
}

function ctxWith(readBook: () => Promise<BookSnapshot>) {
  return { adapter: { readBook } } as never;
}

interface Row {
  seq: bigint;
  side: number;
  priceTick: number;
  amount: bigint;
}

async function mine(ctx: never, owner = ALICE): Promise<Row[]> {
  return (await dispatchAmmRead(
    { functionName: "getMyOpenOrders", args: [MARKET, `sol:${owner}`] } as never,
    ctx,
  )) as Row[];
}

describe("getMyOpenOrders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00Z"));
    __resetBookCache();
    seq = 0n;
  });

  it("returns the caller's orders from both sides", async () => {
    const ctx = ctxWith(async () =>
      snapshot({
        bids: [order(ALICE, 400, 3, 0)],
        asks: [order(ALICE, 600, 2, 1)],
      }),
    );
    const rows = await mine(ctx);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.side).sort()).toEqual([0, 1]);
  });

  it("excludes every other trader's orders", async () => {
    // The book is one shared account. Nothing structural keeps Bob's orders
    // out of Alice's panel — only this filter does.
    const ctx = ctxWith(async () =>
      snapshot({
        bids: [order(BOB, 500, 1, 0), order(ALICE, 490, 1, 0), order(BOB, 480, 1, 0)],
        asks: [order(BOB, 600, 1, 1)],
      }),
    );
    const rows = await mine(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.priceTick).toBe(490);
  });

  it("carries the real seq, which is what cancel consumes", async () => {
    const ctx = ctxWith(async () => snapshot({ bids: [order(ALICE, 400, 1, 0)] }));
    const [row] = await mine(ctx);
    // The end-to-end contract: the id the panel renders must parse back as an
    // exact order, not a price level. A level cancel on the redesigned book is
    // rejected by the hook, so a synthesised id would make cancel unusable.
    const target = parseOrderId(row!.seq.toString());
    expect(target).toEqual({ kind: "id", orderId: row!.seq });
  });

  it("accepts the owner with or without the sol: prefix", async () => {
    // The hook hands addresses through `toHexAddress`, which round-trips the
    // base58 key; a mismatch here silently yields an empty panel rather than
    // an error, so it is worth pinning.
    const ctx = ctxWith(async () => snapshot({ bids: [order(ALICE, 400, 1, 0)] }));
    const bare = (await dispatchAmmRead(
      { functionName: "getMyOpenOrders", args: [MARKET, ALICE] } as never,
      ctx,
    )) as Row[];
    expect(bare).toHaveLength(1);
  });

  it("orders earliest-first, matching consumption order", async () => {
    const a = order(ALICE, 500, 1, 0);
    const b = order(ALICE, 500, 1, 0);
    const c = order(ALICE, 700, 1, 1);
    // Bids and asks are traversed separately, so a naive concat interleaves
    // them by side rather than by time.
    const ctx = ctxWith(async () => snapshot({ bids: [b, a], asks: [c] }));
    const rows = await mine(ctx);
    expect(rows.map((r) => r.seq)).toEqual([a.seq, b.seq, c.seq]);
  });

  it("reports the remaining amount, not the original size", async () => {
    // Partial fills decrement the node in place; there is no separate filled
    // counter to net against, which is exactly why the log-replay arithmetic
    // is unnecessary here.
    const ctx = ctxWith(async () => snapshot({ bids: [order(ALICE, 400, 7, 0)] }));
    expect((await mine(ctx))[0]!.amount).toBe(7n * ONE_SHARE);
  });

  it("returns empty for a trader with no resting orders", async () => {
    const ctx = ctxWith(async () => snapshot({ bids: [order(BOB, 500, 1, 0)] }));
    expect(await mine(ctx)).toEqual([]);
  });

  it("degrades to empty when the market has no book", async () => {
    // A market whose book_init has not run. The panel must read as empty
    // rather than surfacing a thrown promise through react-query.
    const ctx = ctxWith(async () => {
      throw new Error("book account not found");
    });
    expect(await mine(ctx)).toEqual([]);
  });

  it("shares the single-flight cache with the depth read", async () => {
    const readBook = vi.fn(async () => snapshot({ bids: [order(ALICE, 400, 1, 0)] }));
    const ctx = ctxWith(readBook);
    await Promise.all([
      mine(ctx),
      mine(ctx),
      dispatchAmmRead(
        { functionName: "getOrdersAtTick", args: [MARKET, 1, 400] } as never,
        ctx,
      ),
    ]);
    expect(readBook).toHaveBeenCalledTimes(1);
  });
});
