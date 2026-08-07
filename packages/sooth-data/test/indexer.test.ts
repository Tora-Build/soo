// The indexer: storage, idempotency, and the backfill/tail split.
//
// History is the one thing an index is genuinely needed for. Live state — the
// ladder, resting orders, positions, escrow — is one `getAccountInfo` on the
// book account, and indexing it could only produce a slower, staler copy. The
// past is different: events live in transaction logs, and validators discard
// them. On this project a localnet ledger reached 57 GB, was trimmed, and
// order history then read empty on a market that had plainly traded.
//
// So what is tested here is not "does it store rows" but the properties that
// decide whether a running service stays correct:
//
//   - re-ingesting a range must not duplicate (crashes and restarts overlap);
//   - the cursor must never move backwards (a backfill walks BACKWARDS, and
//     letting it drag the tail cursor back re-reads forever);
//   - both sides of a fill must be findable (a maker has to see their fill).

import { describe, expect, it } from "vitest";

import { BookStore } from "../src/db.js";
import { ingestOnce, toRows, type IngestConnection } from "../src/ingest.js";

const MARKET = "Mkt111111111111111111111111111111111111111";
const ALICE = "A11ce1111111111111111111111111111111111111";
const BOB = "Bob111111111111111111111111111111111111111";

function placed(seq: bigint, trader: string, tick: number, amount: bigint) {
  return {
    kind: "book_placed" as const,
    version: 1,
    market: MARKET,
    seq,
    trader,
    side: 0,
    price_tick: tick,
    amount,
    ts: 1000n,
  };
}

function filled(taker: string, legs: Array<[string, bigint, number, bigint]>) {
  return {
    kind: "book_filled" as const,
    version: 1,
    market: MARKET,
    taker,
    taker_side: 0,
    fills: legs.map(([maker, maker_seq, price_tick, amount]) => ({
      maker,
      maker_seq,
      price_tick,
      amount,
    })),
    fee: 5000n,
    ts: 1000n,
  };
}

describe("toRows", () => {
  it("emits one row per fill leg, keyed so both sides can find it", () => {
    // A crossing order sweeps several makers. Collapsing them into the event
    // row would leave each maker unable to find their own fill, which is the
    // whole reason a maker looks at history.
    const { eventRows, fillRows } = toRows(
      [filled(BOB, [[ALICE, 1n, 400, 5n], [ALICE, 2n, 410, 3n]])] as never,
      "sig1", 100, 1700000000, MARKET,
    );
    expect(eventRows).toHaveLength(1);
    expect(fillRows).toHaveLength(2);
    expect(fillRows.map((f) => f.priceTick)).toEqual([400, 410]);
    // Each leg keeps its own execution price — averaging would hide the shape
    // of the sweep.
    expect(fillRows.every((f) => f.maker === ALICE && f.taker === BOB)).toBe(true);
  });

  it("stores u64s as text", () => {
    // `seq` and `amount` are u64. Above 2^53 a JS number silently loses
    // precision, and a sequence is exactly what `book_cancel` takes — a
    // rounded one cancels the wrong order or nothing at all.
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const { eventRows } = toRows(
      [placed(big, ALICE, 400, big)] as never,
      "sig", 1, null, MARKET,
    );
    expect(eventRows[0]!.seq).toBe(big.toString());
    expect(BigInt(eventRows[0]!.seq!)).toBe(big);
  });

  it("leaves a cancel's side and price null rather than guessing", () => {
    // The program frees the node before emitting, so a `cancelled` event
    // carries only the sequence. Inventing a price here would put a number in
    // the database the chain never produced.
    const { eventRows } = toRows(
      [{
        kind: "book_cancelled" as const, version: 1, market: MARKET,
        seq: 7n, trader: ALICE, refund: 400n, ts: 1n,
      }] as never,
      "sig", 1, null, MARKET,
    );
    expect(eventRows[0]!.side).toBeNull();
    expect(eventRows[0]!.priceTick).toBeNull();
    expect(eventRows[0]!.refund).toBe("400");
  });
});

describe("BookStore", () => {
  it("ignores a row it already has", () => {
    // The property that makes the ingester restartable. A crash mid-page means
    // the next run re-walks an overlapping range; without this it would double
    // every event in it.
    const store = new BookStore();
    const { eventRows, fillRows } = toRows(
      [filled(BOB, [[ALICE, 1n, 400, 5n]])] as never, "sig1", 10, null, MARKET,
    );
    expect(store.putEvents(eventRows, fillRows)).toBe(1);
    expect(store.putEvents(eventRows, fillRows)).toBe(0);
    expect(store.counts()).toEqual({ events: 1, fills: 1, markets: 1 });
    store.close();
  });

  it("finds a fill from either side", () => {
    const store = new BookStore();
    const { eventRows, fillRows } = toRows(
      [filled(BOB, [[ALICE, 1n, 400, 5n]])] as never, "sig1", 10, null, MARKET,
    );
    store.putEvents(eventRows, fillRows);
    expect(store.fills(MARKET, 10, ALICE)).toHaveLength(1); // maker
    expect(store.fills(MARKET, 10, BOB)).toHaveLength(1);   // taker
    expect(store.fills(MARKET, 10, "someone-else")).toHaveLength(0);
    store.close();
  });

  it("returns newest first", () => {
    const store = new BookStore();
    for (const [sig, slot] of [["a", 10], ["b", 30], ["c", 20]] as const) {
      const r = toRows([placed(1n, ALICE, 400, 5n)] as never, sig, slot, null, MARKET);
      store.putEvents(r.eventRows, r.fillRows);
    }
    expect(store.events(MARKET).map((e) => e.slot)).toEqual([30, 20, 10]);
    store.close();
  });

  it("keeps markets apart", () => {
    // One database, many markets — so a query that forgot its market filter
    // must not quietly return another market's history.
    const store = new BookStore();
    for (const m of [MARKET, "Other11111111111111111111111111111111111111"]) {
      const r = toRows([placed(1n, ALICE, 400, 5n)] as never, `sig-${m}`, 1, null, m);
      store.putEvents(r.eventRows, r.fillRows);
    }
    expect(store.events(MARKET)).toHaveLength(1);
    expect(store.counts().markets).toBe(2);
    store.close();
  });
});

/** A fake chain: pages of signatures, each mapping to one decodable tx. */
function fakeConnection(
  pages: Array<Array<{ signature: string; slot: number; err?: unknown }>>,
  txFor: (sig: string) => unknown | null,
): IngestConnection & { calls: number } {
  let page = 0;
  return {
    calls: 0,
    async getSignaturesForAddress() {
      this.calls += 1;
      return (pages[page++] ?? []).map((s) => ({ err: null, ...s }));
    },
    async getTransaction(sig: string) {
      return txFor(sig);
    },
  };
}

describe("ingestOnce", () => {
  // A transaction carrying one decodable `placed` event, in the shape
  // `decodeBookEventsFromTransaction` expects.
  const txWithNoEvents = { meta: { innerInstructions: [] } };

  it("records where it reached, so a restart does not rescan", () => {
    // Without a cursor every restart walks from the tip to the beginning of
    // history to learn nothing.
    const store = new BookStore();
    expect(store.getCursor(MARKET)).toBeNull();
    store.setCursor(MARKET, { lastSignature: "sigX", newestSlot: 42, backfilled: true });
    expect(store.getCursor(MARKET)).toMatchObject({
      lastSignature: "sigX", newestSlot: 42, backfilled: true,
    });
    store.close();
  });

  it("never moves the cursor backwards", async () => {
    // A backfill walks BACKWARDS through history. If its oldest page were
    // allowed to set the tail cursor, the next tail pass would start from
    // there and re-read everything after it, forever.
    const store = new BookStore();
    store.setCursor(MARKET, { lastSignature: "newest", newestSlot: 100, backfilled: true });

    const conn = fakeConnection(
      [[{ signature: "older", slot: 5 }]],
      () => txWithNoEvents,
    );
    await ingestOnce(store, conn, { bookAddress: "book", market: MARKET, maxPages: 1 });

    const cursor = store.getCursor(MARKET)!;
    expect(cursor.newestSlot).toBe(100);
    expect(cursor.lastSignature).toBe("newest");
    store.close();
  });

  it("stops paging once the market runs out", async () => {
    // A short page means there is nothing older. Continuing to ask is how an
    // indexer burns its RPC quota discovering nothing — and on public devnet
    // that is a 429 after the second cold request.
    const store = new BookStore();
    const conn = fakeConnection(
      [[{ signature: "a", slot: 3 }]], // one page, shorter than pageSize
      () => txWithNoEvents,
    );
    const r = await ingestOnce(store, conn, {
      bookAddress: "book", market: MARKET, pageSize: 100, maxPages: 5,
    });
    expect(conn.calls).toBe(1);
    expect(r.backfilled).toBe(true);
    store.close();
  });

  it("skips failed transactions", async () => {
    // A failed transaction changed nothing on chain, so it has no history to
    // record — and fetching it is a wasted round trip per failure.
    const store = new BookStore();
    let fetched = 0;
    const conn: IngestConnection = {
      async getSignaturesForAddress() {
        return [{ signature: "bad", slot: 1, err: { InstructionError: [0, "x"] } }];
      },
      async getTransaction() {
        fetched += 1;
        return txWithNoEvents;
      },
    };
    const r = await ingestOnce(store, conn, {
      bookAddress: "book", market: MARKET, pageSize: 100,
    });
    expect(fetched).toBe(0);
    expect(r.scanned).toBe(1);
    expect(r.decoded).toBe(0);
    store.close();
  });

  it("does not advance past a transaction it could not read", async () => {
    // Found by running against a live validator, and it silently LOSES
    // history.
    //
    // Commitment is `finalized`, so a transaction that is confirmed but a few
    // seconds too young returns null from `getTransaction`. An earlier version
    // advanced the cursor to the newest signature SEEN rather than the newest
    // PROCESSED — so the next pass asked only for signatures after it, and
    // that transaction was never read again. The events were on chain and
    // absent from the index, permanently.
    //
    // Re-reading a range costs nothing, because every write is keyed on
    // (signature, event_index). So when a pass is incomplete, the cursor stays
    // put.
    const store = new BookStore();
    const conn: IngestConnection = {
      async getSignaturesForAddress() {
        return [{ signature: "too-young", slot: 500, err: null }];
      },
      async getTransaction() {
        return null; // confirmed, not finalized
      },
    };
    const r = await ingestOnce(store, conn, {
      bookAddress: "b", market: MARKET, pageSize: 100,
    });

    expect(r.pending).toBeGreaterThan(0);
    const cursor = store.getCursor(MARKET)!;
    expect(cursor.lastSignature, "must not skip the unread signature").toBeNull();
    expect(cursor.newestSlot).toBe(0);
    // And it must not claim the backfill finished on an incomplete pass.
    expect(cursor.backfilled).toBe(false);
    store.close();
  });

  it("is a no-op when run twice over the same range", async () => {
    // The end-to-end restatement of idempotency: two identical passes leave
    // the database as one pass would.
    const store = new BookStore();
    const make = () =>
      fakeConnection([[{ signature: "a", slot: 1 }]], () => txWithNoEvents);
    await ingestOnce(store, make(), { bookAddress: "b", market: MARKET, pageSize: 100 });
    const first = store.counts();
    await ingestOnce(store, make(), { bookAddress: "b", market: MARKET, pageSize: 100 });
    expect(store.counts()).toEqual(first);
    store.close();
  });
});
