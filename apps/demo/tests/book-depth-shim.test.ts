// The chain-shim's `getOrdersAtTick` read path.
//
// Enumerating a per-price-level book would mean 999 RPC round trips per side,
// which is why upstream's shim answers `[0n, []]` and the depth panel reads
// "no liquidity".
//
// This book is a single account, so the whole ladder comes from one
// `getAccountInfo`. `useOrderbook` still issues 999 of these through its
// multicall loop, but every one after the first is served from a short cache of
// that single fetch.
//
// Tested against a stub adapter rather than a chain: what matters here is the
// tick filtering, the tuple shape the caller destructures, and that a missing
// book degrades instead of throwing.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookSnapshot } from "@sooth/sdk-solana";

import {
  __resetBookCache,
  dispatchAmmRead,
} from "../src/lib/chain-shim/amm-bridge";

const MARKET = "sol:BtWVTobCWpViPPVpfaz7osbLpeMYjGNw3kNvdFiWE4qJ";
/** What the BOOK counts in: USDC base units. */
const ONE_SHARE = 1_000_000n;
/**
 * What the SHIM returns: WAD.
 *
 * Upstream formats every amount with `formatUnits(x, 18)`, so returning the
 * book's base units rendered 25 shares as 0.000000000000000025 — displayed as
 * "0", with every depth bar zero-width. The ladder had been loading correctly
 * and drawing nothing.
 */
const ONE_SHARE_WAD = 1_000_000_000_000_000_000n;

let seq = 0n;
function order(priceTick: number, shares: number, side: number) {
  return {
    index: Number(seq),
    seq: seq++,
    trader: "Ai1ce11111111111111111111111111111111111111",
    priceTick,
    side,
    amount: BigInt(shares) * ONE_SHARE,
  };
}

function snapshot(): BookSnapshot {
  seq = 0n;
  return {
    market: MARKET.replace("sol:", ""),
    nextSeq: 5n,
    orderCount: 5,
    blockCount: 9,
    capacity: 64,
    // Best first, as the program's intrusive list produces them.
    bids: [order(390, 3, 0), order(390, 2, 0), order(380, 5, 0)],
    asks: [order(610, 4, 1), order(650, 6, 1)],
    seats: [],
  } as BookSnapshot;
}

function ctxWith(readBook: () => Promise<BookSnapshot>) {
  return { adapter: { readBook } } as never;
}

async function depth(ctx: never, side: number, tick: number) {
  return (await dispatchAmmRead(
    { functionName: "getOrdersAtTick", args: [MARKET, side, tick] } as never,
    ctx,
  )) as readonly [bigint, readonly unknown[]];
}

describe("getOrdersAtTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00Z"));
    // The cache is module-level, so without this each case would inherit the
    // previous one's warm entry and observe zero fetches.
    __resetBookCache();
  });

  it("aggregates every order resting at a tick", async () => {
    const ctx = ctxWith(async () => snapshot());
    const [total, orders] = await depth(ctx, 1, 390);
    // Two orders at 390 — 3 + 2 shares, reported in WAD.
    expect(total).toBe(5n * ONE_SHARE_WAD);
    expect(orders).toHaveLength(2);
  });

  it("reads both sides off the same YES axis", async () => {
    // No complement flip. A bid at 390 and an ask at 610 are quoted on one
    // axis, so the tick maps straight through — the legacy two-sided book
    // required inverting one side, which is how a panel ends up rendering the
    // wrong side of the market.
    const ctx = ctxWith(async () => snapshot());
    expect((await depth(ctx, 1, 390))[0]).toBe(5n * ONE_SHARE_WAD);
    expect((await depth(ctx, 0, 610))[0]).toBe(4n * ONE_SHARE_WAD);
    // A bid tick queried on the ask side finds nothing, rather than silently
    // returning the complement's depth.
    expect((await depth(ctx, 0, 390))[0]).toBe(0n);
  });

  it("reports WAD, the scale every upstream formatter assumes", async () => {
    // The bug this pins. `useOrderbook` renders with `formatUnits(x, 18)`, so
    // base units come out as 0.000000000000000025 — "0" on screen, and a
    // zero-width depth bar. Asserting the SCALE, not just the number, is what
    // makes that visible in a test rather than only in a browser.
    const ctx = ctxWith(async () => snapshot());
    const [total] = await depth(ctx, 1, 390);
    expect(total).toBe(5n * ONE_SHARE_WAD);
    expect(Number(total) / 1e18).toBeCloseTo(5, 10);
  });

  it("returns an empty level rather than undefined", async () => {
    // The tuple shape is load-bearing: `useOrderbook.scanTickDepth`
    // destructures `[totalAmount] = result.result`, and a bare undefined
    // throws inside the multicall loop and leaves `isLoading` stuck.
    const ctx = ctxWith(async () => snapshot());
    const [total, orders] = await depth(ctx, 1, 500);
    expect(total).toBe(0n);
    expect(orders).toEqual([]);
  });

  it("fetches the book once across many tick queries", async () => {
    // The whole point. 999 ticks per side must not become 999 fetches.
    const readBook = vi.fn(async () => snapshot());
    const ctx = ctxWith(readBook);
    for (let tick = 1; tick <= 60; tick += 1) await depth(ctx, 1, tick);
    expect(readBook).toHaveBeenCalledTimes(1);
  });

  it("fetches once even when every tick is requested CONCURRENTLY", async () => {
    // The case the sequential test above cannot catch, and the one that
    // actually broke: `useOrderbook.scanTickDepth` issues its 999 tick reads
    // through a multicall, so they all run at once. A cache keyed on the
    // RESOLVED value is checked by all of them before any resolves — every one
    // misses, and the shim fires ~2,000 RPC calls per poll. Against a local
    // validator that reads as the market list hanging forever.
    //
    // Caching the in-flight promise is what makes this one fetch.
    let resolveFetch: (v: BookSnapshot) => void = () => {};
    const readBook = vi.fn(
      () =>
        new Promise<BookSnapshot>((res) => {
          resolveFetch = res;
        }),
    );
    const ctx = ctxWith(readBook);

    const all = Promise.all(
      Array.from({ length: 200 }, (_, i) => depth(ctx, 1, i + 1)),
    );
    // Nothing has resolved yet — this is precisely the window the value-cache
    // left open.
    expect(readBook).toHaveBeenCalledTimes(1);
    resolveFetch(snapshot());
    await all;
    expect(readBook).toHaveBeenCalledTimes(1);
  });

  it("refetches once the cache expires", async () => {
    // A stale ladder is worse than a slow one; the panel polls every 10s.
    const readBook = vi.fn(async () => snapshot());
    const ctx = ctxWith(readBook);
    await depth(ctx, 1, 390);
    vi.advanceTimersByTime(5_000);
    await depth(ctx, 1, 390);
    expect(readBook).toHaveBeenCalledTimes(2);
  });

  it("degrades to empty when the market has no book", async () => {
    // A market created before the redesign, or one whose book_init has not
    // run. The panel must read as empty, not stall on a thrown promise.
    const readBook = vi.fn(async () => {
      throw new Error("book account not found");
    });
    const ctx = ctxWith(readBook as never);
    const [total, orders] = await depth(ctx, 1, 390);
    expect(total).toBe(0n);
    expect(orders).toEqual([]);
  });

  it("does not retry a missing book for every tick", async () => {
    const readBook = vi.fn(async () => {
      throw new Error("book account not found");
    });
    const ctx = ctxWith(readBook as never);
    for (let tick = 1; tick <= 40; tick += 1) await depth(ctx, 1, tick);
    expect(readBook).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed side rather than guessing", async () => {
    const ctx = ctxWith(async () => snapshot());
    const [total] = (await dispatchAmmRead(
      { functionName: "getOrdersAtTick", args: [MARKET, 7, 390] } as never,
      ctx,
    )) as readonly [bigint, readonly unknown[]];
    expect(total).toBe(0n);
  });
});
