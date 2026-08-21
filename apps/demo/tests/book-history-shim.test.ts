// Order history from the book's own CPI events.
//
// The EVM-shaped ORDER_PLACED / ORDER_CANCELLED / ORDER_FILLED log scan
// upstream uses has no counterpart here: the book emits none of those
// signatures and there is no indexer. This read walks the account's own
// signature history instead.
//
// Three properties carry the weight:
//
//   1. A fill is visible to BOTH parties. Attributing it only to the taker
//      would hide from a maker that their resting order traded at all.
//   2. The execution price is the MAKER's tick, never the taker's limit — that
//      difference IS the price improvement, and showing the limit would report
//      a worse fill than the trader actually got.
//   3. A `cancelled` event carries only a seq, so the side and price are
//      recovered from the matching `placed` event seen earlier in the stream.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetBookCache,
  dispatchAmmRead,
} from "../src/lib/chain-shim/amm-bridge";

const MARKET = "sol:BtWVTobCWpViPPVpfaz7osbLpeMYjGNw3kNvdFiWE4qJ";
const ALICE = "Ai1ce11111111111111111111111111111111111111";
const BOB = "Bob11111111111111111111111111111111111111111";
const ONE_SHARE = 1_000_000n;

interface Row {
  signature: string;
  type: "placed" | "filled" | "cancelled";
  role?: "maker" | "taker";
  seq: bigint;
  side: number | null;
  priceTick: number | null;
  amount: bigint;
  refund?: bigint;
  ts: bigint;
}

function ctxWith(readBookHistory: () => Promise<unknown>) {
  return { adapter: { readBookHistory } } as never;
}

async function history(ctx: never, owner = ALICE): Promise<Row[]> {
  return (await dispatchAmmRead(
    { functionName: "getMyOrderHistory", args: [MARKET, `sol:${owner}`] } as never,
    ctx,
  )) as Row[];
}

const placed = (trader: string, seq: bigint, side: number, tick: number, shares: number) => ({
  signature: `sig-placed-${seq}`,
  slot: Number(seq),
  event: {
    kind: "placed" as const,
    version: 1,
    market: MARKET.replace("sol:", ""),
    seq,
    trader,
    side,
    priceTick: tick,
    amount: BigInt(shares) * ONE_SHARE,
    ts: 1_000n + seq,
  },
});

const cancelled = (trader: string, seq: bigint, refund: bigint) => ({
  signature: `sig-cancel-${seq}`,
  slot: Number(seq) + 100,
  event: {
    kind: "cancelled" as const,
    version: 1,
    market: MARKET.replace("sol:", ""),
    seq,
    trader,
    refund,
    ts: 2_000n + seq,
  },
});

const filled = (
  taker: string,
  takerSide: number,
  fills: Array<{ maker: string; makerSeq: bigint; priceTick: number; shares: number }>,
) => ({
  signature: `sig-fill-${taker}-${takerSide}`,
  slot: 500,
  event: {
    kind: "filled" as const,
    version: 1,
    market: MARKET.replace("sol:", ""),
    taker,
    takerSide,
    fills: fills.map((f) => ({
      maker: f.maker,
      makerSeq: f.makerSeq,
      priceTick: f.priceTick,
      amount: BigInt(f.shares) * ONE_SHARE,
    })),
    fee: 5_000n,
    ts: 3_000n,
  },
});

describe("getMyOrderHistory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00Z"));
    __resetBookCache();
  });

  it("returns the caller's own placements", async () => {
    const ctx = ctxWith(async () => [
      placed(ALICE, 1n, 0, 470, 25),
      placed(BOB, 2n, 0, 460, 10),
    ]);
    const rows = await history(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("placed");
    expect(rows[0]!.priceTick).toBe(470);
  });

  it("shows a fill to the TAKER at the maker's price", async () => {
    // The taker crossed with some limit; they executed at 440, the maker's
    // tick. Reporting the taker's limit would understate the fill.
    const ctx = ctxWith(async () => [
      filled(ALICE, 0, [{ maker: BOB, makerSeq: 9n, priceTick: 440, shares: 5 }]),
    ]);
    const rows = await history(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("taker");
    expect(rows[0]!.priceTick).toBe(440);
  });

  it("shows the SAME fill to the maker whose order was consumed", async () => {
    // The property that matters most: a maker must learn their resting order
    // traded. The legacy taker-only attribution left them with no record.
    const ctx = ctxWith(async () => [
      filled(BOB, 0, [{ maker: ALICE, makerSeq: 7n, priceTick: 440, shares: 5 }]),
    ]);
    const rows = await history(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("maker");
    expect(rows[0]!.seq).toBe(7n);
  });

  it("puts the maker on the side opposite the taker", async () => {
    const ctx = ctxWith(async () => [
      filled(BOB, 0, [{ maker: ALICE, makerSeq: 7n, priceTick: 440, shares: 5 }]),
    ]);
    expect((await history(ctx))[0]!.side).toBe(1);
  });

  it("charges the fee to the taker only", async () => {
    // Both parties see the fill; only one paid for it. Showing the fee on the
    // maker's row would overstate their cost.
    const asTaker = await history(
      ctxWith(async () => [
        filled(ALICE, 0, [{ maker: BOB, makerSeq: 1n, priceTick: 440, shares: 5 }]),
      ]),
    );
    const asMaker = await history(
      ctxWith(async () => [
        filled(BOB, 0, [{ maker: ALICE, makerSeq: 1n, priceTick: 440, shares: 5 }]),
      ]),
    );
    expect((asTaker[0] as unknown as { fee: bigint }).fee).toBe(5_000n);
    expect((asMaker[0] as unknown as { fee: bigint }).fee).toBe(0n);
  });

  it("emits one row per resting order a taker swept", async () => {
    const ctx = ctxWith(async () => [
      filled(ALICE, 0, [
        { maker: BOB, makerSeq: 1n, priceTick: 440, shares: 5 },
        { maker: BOB, makerSeq: 2n, priceTick: 450, shares: 3 },
        { maker: BOB, makerSeq: 3n, priceTick: 460, shares: 2 },
      ]),
    ]);
    const rows = await history(ctx);
    expect(rows).toHaveLength(3);
    // Each leg keeps its own execution price — averaging them would hide the
    // shape of the sweep.
    expect(rows.map((r) => r.priceTick)).toEqual([440, 450, 460]);
  });

  it("recovers a cancel's side and price from its earlier placement", async () => {
    // The `cancelled` event carries only the seq; the program has already freed
    // the node. Without this the row renders as an order with no price.
    const ctx = ctxWith(async () => [
      placed(ALICE, 4n, 1, 620, 12),
      cancelled(ALICE, 4n, 7_000_000n),
    ]);
    const rows = await history(ctx);
    const cancel = rows.find((r) => r.type === "cancelled")!;
    expect(cancel.side).toBe(1);
    expect(cancel.priceTick).toBe(620);
    expect(cancel.refund).toBe(7_000_000n);
  });

  it("leaves a cancel's price null when the placement predates the window", async () => {
    // Honest about the gap. Defaulting to 0 or 500 would render a real-looking
    // price the chain never saw.
    const ctx = ctxWith(async () => [cancelled(ALICE, 99n, 1_000n)]);
    const [row] = await history(ctx);
    expect(row!.side).toBeNull();
    expect(row!.priceTick).toBeNull();
  });

  it("excludes other traders throughout", async () => {
    const ctx = ctxWith(async () => [
      placed(BOB, 1n, 0, 470, 25),
      cancelled(BOB, 1n, 100n),
      filled(BOB, 0, [{ maker: BOB, makerSeq: 2n, priceTick: 440, shares: 5 }]),
    ]);
    expect(await history(ctx)).toEqual([]);
  });

  it("degrades to empty when the market has no book", async () => {
    const ctx = ctxWith(async () => {
      throw new Error("book account not found");
    });
    expect(await history(ctx)).toEqual([]);
  });
});
