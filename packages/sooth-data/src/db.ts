// Durable storage for book history.
//
// ## What belongs here, and what does not
//
// Only HISTORY. Live state — the ladder, a trader's resting orders, their
// position and escrow — is one `getAccountInfo` on the book account, and an
// index of it could only ever be a slower, staler copy. Indexing live state is
// the classic mistake carried over from EVM, where the book is spread across
// contract storage and reconstruction is the only option. It is not the only
// option here.
//
// What the chain does NOT keep is the past. Events live in transaction logs,
// and validators discard them: on this project a localnet ledger reached 57 GB
// and then had to be trimmed, at which point order history read empty on a
// market that had plainly traded. RPC providers trim too, typically to days.
// So history is the one thing that genuinely needs a database.
//
// ## Why SQLite, and why `node:sqlite`
//
// No new dependency: Node ships it. That matters for a service whose whole job
// is to be boring — one file on disk, no daemon, no connection pool, no
// migration tool. It is enough for testnet and for a long way past it; a
// single market's entire history is thousands of rows, not millions.
//
// The schema is deliberately portable — plain SQL, no SQLite-specific types —
// so moving to Postgres later is a driver swap rather than a rewrite. When
// that day comes it will be for concurrent writers, not for volume.
//
// ## Idempotency
//
// Every write is keyed on `(signature, event_index)`, so re-ingesting a range
// is a no-op rather than a duplicate. That is what makes the ingester safe to
// restart, safe to run twice, and safe to point at an overlapping range after
// a crash — which it will be, because the alternative is tracking exactly-once
// delivery across a process boundary.

// `node:sqlite` is loaded through `createRequire` rather than imported.
//
// It ships with Node 22.5+, but bundlers that predate it do not know it is a
// builtin: Vite strips the `node:` prefix and then fails looking for a package
// called "sqlite". Requiring it at runtime keeps resolution with Node, where
// it belongs, and costs nothing — this module is server-only.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDb;
};

/** The slice of `node:sqlite` used here — it ships no type declarations yet. */
interface SqliteDb {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface BookEventRow {
  signature: string;
  eventIndex: number;
  slot: number;
  blockTime: number | null;
  market: string;
  kind: "placed" | "cancelled" | "filled";
  /** `placed` / `cancelled` — the order's owner. */
  trader: string | null;
  /** `filled` — the aggressing side. */
  taker: string | null;
  /** u64, stored as text: JS numbers lose precision above 2^53. */
  seq: string | null;
  side: number | null;
  priceTick: number | null;
  amount: string | null;
  refund: string | null;
  fee: string | null;
  ts: string | null;
}

export interface BookFillRow {
  signature: string;
  eventIndex: number;
  fillIndex: number;
  market: string;
  taker: string;
  maker: string;
  makerSeq: string;
  /** Execution price — the MAKER's tick, never the taker's limit. */
  priceTick: number;
  amount: string;
  slot: number;
  blockTime: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS book_events (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  market      TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  trader      TEXT,
  taker       TEXT,
  seq         TEXT,
  side        INTEGER,
  price_tick  INTEGER,
  amount      TEXT,
  refund      TEXT,
  fee         TEXT,
  ts          TEXT,
  PRIMARY KEY (signature, event_index)
);

-- One row per (taker, maker) leg. A single crossing order produces several,
-- and both sides need to find their own, so this is indexed from both.
CREATE TABLE IF NOT EXISTS book_fills (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  fill_index  INTEGER NOT NULL,
  market      TEXT    NOT NULL,
  taker       TEXT    NOT NULL,
  maker       TEXT    NOT NULL,
  maker_seq   TEXT    NOT NULL,
  price_tick  INTEGER NOT NULL,
  amount      TEXT    NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  PRIMARY KEY (signature, event_index, fill_index)
);

-- Where ingestion got to, per market. Without this every restart rescans from
-- the tip and re-walks history the service already has.
CREATE TABLE IF NOT EXISTS ingest_cursor (
  market         TEXT PRIMARY KEY,
  last_signature TEXT,
  newest_slot    INTEGER NOT NULL DEFAULT 0,
  oldest_slot    INTEGER NOT NULL DEFAULT 0,
  backfilled     INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_market_slot ON book_events (market, slot DESC);
CREATE INDEX IF NOT EXISTS idx_events_trader      ON book_events (market, trader, slot DESC);
CREATE INDEX IF NOT EXISTS idx_events_taker       ON book_events (market, taker, slot DESC);
CREATE INDEX IF NOT EXISTS idx_fills_market_slot  ON book_fills  (market, slot DESC);
CREATE INDEX IF NOT EXISTS idx_fills_maker        ON book_fills  (market, maker, slot DESC);
CREATE INDEX IF NOT EXISTS idx_fills_taker        ON book_fills  (market, taker, slot DESC);
`;

export class BookStore {
  private readonly db: SqliteDb;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    // WAL lets the API read while the ingester writes. Without it a read
    // blocks behind every insert, which for a service whose whole point is
    // serving reads during ingestion is the wrong trade.
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Insert events and fills, ignoring anything already stored.
   *
   * Returns how many rows were NEW, which is what tells a caller whether a
   * range was worth walking — and is the number to watch if ingestion ever
   * looks like it is running but achieving nothing.
   */
  putEvents(events: BookEventRow[], fills: BookFillRow[]): number {
    const insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO book_events
        (signature, event_index, slot, block_time, market, kind, trader, taker,
         seq, side, price_tick, amount, refund, fee, ts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertFill = this.db.prepare(`
      INSERT OR IGNORE INTO book_fills
        (signature, event_index, fill_index, market, taker, maker, maker_seq,
         price_tick, amount, slot, block_time)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);

    let inserted = 0;
    this.db.exec("BEGIN");
    try {
      for (const e of events) {
        const r = insertEvent.run(
          e.signature, e.eventIndex, e.slot, e.blockTime, e.market, e.kind,
          e.trader, e.taker, e.seq, e.side, e.priceTick, e.amount, e.refund,
          e.fee, e.ts,
        );
        inserted += Number(r.changes);
      }
      for (const f of fills) {
        insertFill.run(
          f.signature, f.eventIndex, f.fillIndex, f.market, f.taker, f.maker,
          f.makerSeq, f.priceTick, f.amount, f.slot, f.blockTime,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return inserted;
  }

  /** Where ingestion has reached for a market. */
  getCursor(market: string): {
    lastSignature: string | null;
    newestSlot: number;
    oldestSlot: number;
    backfilled: boolean;
  } | null {
    const row = this.db
      .prepare(
        `SELECT last_signature, newest_slot, oldest_slot, backfilled
           FROM ingest_cursor WHERE market = ?`,
      )
      .get(market) as
      | {
          last_signature: string | null;
          newest_slot: number;
          oldest_slot: number;
          backfilled: number;
        }
      | undefined;
    if (!row) return null;
    return {
      lastSignature: row.last_signature,
      newestSlot: row.newest_slot,
      oldestSlot: row.oldest_slot,
      backfilled: row.backfilled === 1,
    };
  }

  setCursor(
    market: string,
    next: {
      lastSignature?: string | null;
      newestSlot?: number;
      oldestSlot?: number;
      backfilled?: boolean;
    },
  ): void {
    const cur = this.getCursor(market);
    this.db
      .prepare(
        `INSERT INTO ingest_cursor
           (market, last_signature, newest_slot, oldest_slot, backfilled, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(market) DO UPDATE SET
           last_signature = excluded.last_signature,
           newest_slot    = excluded.newest_slot,
           oldest_slot    = excluded.oldest_slot,
           backfilled     = excluded.backfilled,
           updated_at     = excluded.updated_at`,
      )
      .run(
        market,
        next.lastSignature ?? cur?.lastSignature ?? null,
        next.newestSlot ?? cur?.newestSlot ?? 0,
        next.oldestSlot ?? cur?.oldestSlot ?? 0,
        (next.backfilled ?? cur?.backfilled ?? false) ? 1 : 0,
        Date.now(),
      );
  }

  /** Fills for a market, newest first. Both sides of each fill are findable. */
  fills(market: string, limit = 200, party?: string): BookFillRow[] {
    const sql = party
      ? `SELECT * FROM book_fills
          WHERE market = ? AND (maker = ? OR taker = ?)
          ORDER BY slot DESC, fill_index ASC LIMIT ?`
      : `SELECT * FROM book_fills
          WHERE market = ? ORDER BY slot DESC, fill_index ASC LIMIT ?`;
    const rows = (
      party
        ? this.db.prepare(sql).all(market, party, party, limit)
        : this.db.prepare(sql).all(market, limit)
    ) as Array<Record<string, unknown>>;
    return rows.map(fromFillRow);
  }

  /** Every event for a market, newest first; optionally one trader's. */
  events(market: string, limit = 200, trader?: string): BookEventRow[] {
    const sql = trader
      ? `SELECT * FROM book_events
          WHERE market = ? AND (trader = ? OR taker = ?)
          ORDER BY slot DESC, event_index ASC LIMIT ?`
      : `SELECT * FROM book_events
          WHERE market = ? ORDER BY slot DESC, event_index ASC LIMIT ?`;
    const rows = (
      trader
        ? this.db.prepare(sql).all(market, trader, trader, limit)
        : this.db.prepare(sql).all(market, limit)
    ) as Array<Record<string, unknown>>;
    return rows.map(fromEventRow);
  }

  counts(): { events: number; fills: number; markets: number } {
    const one = (sql: string) =>
      Number((this.db.prepare(sql).get() as { c: number }).c);
    return {
      events: one("SELECT count(*) c FROM book_events"),
      fills: one("SELECT count(*) c FROM book_fills"),
      markets: one("SELECT count(DISTINCT market) c FROM book_events"),
    };
  }
}

function fromEventRow(r: Record<string, unknown>): BookEventRow {
  return {
    signature: r.signature as string,
    eventIndex: Number(r.event_index),
    slot: Number(r.slot),
    blockTime: r.block_time === null ? null : Number(r.block_time),
    market: r.market as string,
    kind: r.kind as BookEventRow["kind"],
    trader: (r.trader as string) ?? null,
    taker: (r.taker as string) ?? null,
    seq: (r.seq as string) ?? null,
    side: r.side === null ? null : Number(r.side),
    priceTick: r.price_tick === null ? null : Number(r.price_tick),
    amount: (r.amount as string) ?? null,
    refund: (r.refund as string) ?? null,
    fee: (r.fee as string) ?? null,
    ts: (r.ts as string) ?? null,
  };
}

function fromFillRow(r: Record<string, unknown>): BookFillRow {
  return {
    signature: r.signature as string,
    eventIndex: Number(r.event_index),
    fillIndex: Number(r.fill_index),
    market: r.market as string,
    taker: r.taker as string,
    maker: r.maker as string,
    makerSeq: r.maker_seq as string,
    priceTick: Number(r.price_tick),
    amount: r.amount as string,
    slot: Number(r.slot),
    blockTime: r.block_time === null ? null : Number(r.block_time),
  };
}
