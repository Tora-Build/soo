// Alchemy's Account Archive, and the line between it and the event index.
//
// The archive answers `getAccountInfo` at any past slot. That genuinely
// removes work — a price chart is now a series of account reads rather than a
// replay of every trade — but it is captured PER SLOT, and our fills are per
// TRANSACTION. Two transactions in one slot collapse to one state, so a fill
// can be unobservable in the archive while sitting plainly in an event.
//
// These tests pin the parts that are easy to get wrong: the historical
// parameters are mutually exclusive and require `finalized`; the write-walk
// must terminate; and the price maths must match the program's.

import { describe, expect, it } from "vitest";

import {
  ArchiveUnsupportedError,
  getAccountAt,
  walkWrites,
  type RpcCall,
} from "../src/account-archive.js";
import { lmsrPrice, priceHistory, toPricePoint } from "../src/price-history.js";

const ADDR = "Amm1111111111111111111111111111111111111111";

/** An AmmState account body: discriminator, market pubkey, q_yes, q_no, b. */
function ammAccount(qYes: number, qNo: number, b: number): string {
  const buf = Buffer.alloc(8 + 32 + 16 * 6);
  const wad = (n: number) => BigInt(Math.round(n * 1e18));
  const writeI128 = (v: bigint, off: number) => {
    buf.writeBigUInt64LE(v & 0xffffffffffffffffn, off);
    buf.writeBigInt64LE(v >> 64n, off + 8);
  };
  writeI128(wad(qYes), 8 + 32);
  writeI128(wad(qNo), 8 + 32 + 16);
  writeI128(wad(b), 8 + 32 + 32);
  return buf.toString("base64");
}

function rpcReturning(
  handler: (params: unknown[]) => { data: string; slot: number } | null,
): RpcCall & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn = (async (_method: string, params: unknown[]) => {
    calls.push(params);
    const out = handler(params);
    if (!out) return { result: { value: null, context: { slot: 0 } } };
    return {
      result: {
        value: { data: [out.data, "base64"], owner: "prog", lamports: 1 },
        context: { slot: out.slot },
      },
    };
  }) as RpcCall & { calls: unknown[][] };
  fn.calls = calls;
  return fn;
}

describe("getAccountAt", () => {
  it("sends finalized with a historical read", async () => {
    // The archive rejects `processed`/`confirmed` alongside a historical
    // parameter. Sending it explicitly means a changed default fails loudly
    // instead of silently returning live state for a historical question.
    const rpc = rpcReturning(() => ({ data: ammAccount(1, 1, 10), slot: 500 }));
    await getAccountAt(rpc, ADDR, { slot: 500 });
    const config = rpc.calls[0]![1] as Record<string, unknown>;
    expect(config.commitment).toBe("finalized");
    expect(config.slot).toBe(500);
  });

  it("sends no commitment for a live read", async () => {
    // A live read must not be pinned to finalized — that would silently add
    // ~13s of lag to every current-state query in the service.
    const rpc = rpcReturning(() => ({ data: ammAccount(1, 1, 10), slot: 9 }));
    await getAccountAt(rpc, ADDR);
    const config = rpc.calls[0]![1] as Record<string, unknown>;
    expect(config.commitment).toBeUndefined();
    expect(config.slot).toBeUndefined();
  });

  it("returns null for an account that did not exist yet", async () => {
    // A real answer, not an error: it is how a caller finds when a market was
    // created.
    const rpc = rpcReturning(() => null);
    expect(await getAccountAt(rpc, ADDR, { slot: 1 })).toBeNull();
  });

  it("names the cause when the RPC has no archive", async () => {
    // The fix is "point at a provider that has it", not "retry" — so this must
    // not look like a transient failure.
    const rpc: RpcCall = async () => ({
      error: { code: -32602, message: "unknown field `slot`" },
    });
    await expect(getAccountAt(rpc, ADDR, { slot: 1 })).rejects.toBeInstanceOf(
      ArchiveUnsupportedError,
    );
  });
});

describe("walkWrites", () => {
  it("follows firstUpdateAfterSlot forward", async () => {
    const slots = [10, 20, 35];
    let i = 0;
    const rpc = rpcReturning(() =>
      i < slots.length ? { data: ammAccount(i, 0, 10), slot: slots[i++]! } : null,
    );
    const writes = await walkWrites(rpc, ADDR, 0, 10);
    expect(writes.map((w) => w.slot)).toEqual(slots);
  });

  it("stops rather than looping when the slot does not advance", async () => {
    // An RPC that keeps answering with the same slot would otherwise spin
    // forever, one request at a time, against a metered endpoint.
    const rpc = rpcReturning(() => ({ data: ammAccount(1, 1, 10), slot: 7 }));
    const writes = await walkWrites(rpc, ADDR, 7, 50);
    expect(writes).toHaveLength(0);
  });

  it("honours maxSteps so cost is the caller's decision", async () => {
    let slot = 0;
    const rpc = rpcReturning(() => ({ data: ammAccount(1, 1, 10), slot: ++slot }));
    expect(await walkWrites(rpc, ADDR, 0, 5)).toHaveLength(5);
  });
});

describe("price from archived state", () => {
  it("matches the program's LMSR", () => {
    // Same shifted log-sum-exp as `lmsr.rs`. A balanced book is 0.50 and the
    // long side is dearer.
    expect(lmsrPrice(100, 100, 50)).toBeCloseTo(0.5, 12);
    expect(lmsrPrice(150, 100, 50)).toBeGreaterThan(0.5);
    expect(lmsrPrice(100, 150, 50)).toBeLessThan(0.5);
  });

  it("does not overflow at large q/b", () => {
    // Unshifted, `exp(3500/50)` is 2.5e30 and `exp(q/b)` for a bigger market
    // is Infinity — which would render as a gap in a chart rather than an
    // error. The shift is what keeps this finite.
    const p = lmsrPrice(3500, 3500, 50);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeCloseTo(0.5, 12);
  });

  it("returns 0.5 rather than NaN for an uninitialised account", () => {
    expect(lmsrPrice(0, 0, 0)).toBe(0.5);
  });

  it("decodes q_yes / q_no / b at their real offsets", () => {
    const account = {
      data: Buffer.from(ammAccount(150, 100, 50), "base64"),
      owner: "p",
      lamports: 1,
      slot: 42,
    };
    const point = toPricePoint(account)!;
    expect(point.qYes).toBeCloseTo(150, 6);
    expect(point.qNo).toBeCloseTo(100, 6);
    expect(point.b).toBeCloseTo(50, 6);
    expect(point.slot).toBe(42);
    expect(point.price).toBeCloseTo(lmsrPrice(150, 100, 50), 12);
  });

  it("ignores an account too short to be an AmmState", () => {
    const account = { data: Buffer.alloc(8), owner: "p", lamports: 1, slot: 1 };
    expect(toPricePoint(account)).toBeNull();
  });

  it("builds a series, one request per state change", async () => {
    // The point of the archive for charts: cost tracks how often the market
    // MOVED, not how many slots it spanned.
    const moves = [
      { q: 100, slot: 10 },
      { q: 120, slot: 900 },
      { q: 140, slot: 5000 },
    ];
    let i = 0;
    const rpc = rpcReturning(() =>
      i < moves.length
        ? { data: ammAccount(moves[i]!.q, 100, 50), slot: moves[i++]!.slot }
        : null,
    );
    const series = await priceHistory(rpc, ADDR, 0, 50);
    expect(series.map((p) => p.slot)).toEqual([10, 900, 5000]);
    expect(series[0]!.price).toBeCloseTo(0.5, 12);
    expect(series[2]!.price).toBeGreaterThan(series[0]!.price);
    // Three moves across ~5000 slots cost three requests.
    expect(rpc.calls.length).toBe(4); // three hits plus the terminating miss
  });
});
