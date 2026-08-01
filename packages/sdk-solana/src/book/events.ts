// Decoders for the redesigned book's events.
//
// ## Where the payload lives
//
// These are emitted with Anchor's `emit_cpi!`, which self-invokes the program
// so the payload becomes an **inner instruction** rather than a program log.
// Logs are truncated and not reliably retrievable from every RPC; an inner
// instruction is real transaction data that `getTransaction` returns.
//
// That is precisely what the separate `sooth_log` program was built to provide.
// It exists because of a belief that a program cannot CPI into itself — but
// Solana permits direct self recursion, which is the mechanism Anchor uses
// here. See `instructions/book_place.rs`.
//
// The wire framing of an `emit_cpi!` inner instruction is:
//
//   [8-byte Anchor CPI-event tag][8-byte event discriminator][borsh body]
//
// ## Versioning
//
// Every event's first field is a `version` byte, and these decoders **reject an
// unknown version** rather than guessing. The existing book's events have no
// version at all, and both failure modes are live today: `sooth-data` throws on
// trailing bytes, so adding one field 500s `GET /v12/fills`; and a renamed
// event returns an empty list with HTTP 200, which is silent data loss.

import { PublicKey } from "@solana/web3.js";

/** Anchor's marker for a self-CPI event instruction. */
export const CPI_EVENT_TAG = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);

/** The version these decoders understand. */
export const BOOK_EVENT_VERSION = 1;

/** sha256("event:<Name>")[..8] */
export const BOOK_EVENT_DISC = {
  filled: Buffer.from([134, 27, 55, 180, 174, 105, 208, 243]),
  placed: Buffer.from([249, 106, 60, 191, 67, 209, 179, 21]),
  cancelled: Buffer.from([30, 121, 53, 249, 40, 18, 202, 9]),
} as const;

export interface BookFillRecord {
  maker: string;
  makerSeq: bigint;
  /** Execution price — the MAKER's tick, not the taker's limit. */
  priceTick: number;
  amount: bigint;
}

export interface BookFilledEvent {
  kind: "filled";
  version: number;
  market: string;
  taker: string;
  takerSide: number;
  fills: BookFillRecord[];
  fee: bigint;
  ts: bigint;
}

export interface BookOrderPlacedEvent {
  kind: "placed";
  version: number;
  market: string;
  seq: bigint;
  trader: string;
  side: number;
  priceTick: number;
  amount: bigint;
  ts: bigint;
}

export interface BookOrderCancelledEvent {
  kind: "cancelled";
  version: number;
  market: string;
  seq: bigint;
  trader: string;
  refund: bigint;
  ts: bigint;
}

export type BookEvent =
  | BookFilledEvent
  | BookOrderPlacedEvent
  | BookOrderCancelledEvent;

class Reader {
  private o = 0;
  constructor(private readonly b: Buffer) {}
  u8(): number {
    return this.b.readUInt8(this.o++);
  }
  u16(): number {
    const v = this.b.readUInt16LE(this.o);
    this.o += 2;
    return v;
  }
  u32(): number {
    const v = this.b.readUInt32LE(this.o);
    this.o += 4;
    return v;
  }
  u64(): bigint {
    const v = this.b.readBigUInt64LE(this.o);
    this.o += 8;
    return v;
  }
  i64(): bigint {
    const v = this.b.readBigInt64LE(this.o);
    this.o += 8;
    return v;
  }
  pubkey(): string {
    const v = new PublicKey(this.b.subarray(this.o, this.o + 32)).toBase58();
    this.o += 32;
    return v;
  }
  /** Assert the whole payload was consumed. */
  done(what: string): void {
    if (this.o !== this.b.length) {
      throw new Error(
        `${what}: ${this.b.length - this.o} trailing bytes — decoder and \
program disagree on layout`,
      );
    }
  }
}

function checkVersion(v: number, what: string): void {
  // Reject rather than guess. A future version may reorder fields, and reading
  // v2 with a v1 decoder produces plausible garbage, not an error.
  if (v !== BOOK_EVENT_VERSION) {
    throw new Error(
      `${what}: unsupported event version ${v} (this decoder handles ${BOOK_EVENT_VERSION})`,
    );
  }
}

/**
 * Decode one `emit_cpi!` payload, or `null` if it is not a book event.
 *
 * `null` for "not ours" and a throw for "ours but malformed" — so an unrelated
 * inner instruction is skipped quietly while a real layout drift is loud.
 */
export function decodeBookEvent(data: Buffer | Uint8Array): BookEvent | null {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 16) return null;
  if (!buf.subarray(0, 8).equals(CPI_EVENT_TAG)) return null;

  const disc = buf.subarray(8, 16);
  const body = new Reader(buf.subarray(16));

  if (disc.equals(BOOK_EVENT_DISC.filled)) {
    const version = body.u8();
    checkVersion(version, "BookFilled");
    const market = body.pubkey();
    const taker = body.pubkey();
    const takerSide = body.u8();
    const n = body.u32();
    const fills: BookFillRecord[] = [];
    for (let i = 0; i < n; i++) {
      fills.push({
        maker: body.pubkey(),
        makerSeq: body.u64(),
        priceTick: body.u16(),
        amount: body.u64(),
      });
    }
    const fee = body.u64();
    const ts = body.i64();
    body.done("BookFilled");
    return { kind: "filled", version, market, taker, takerSide, fills, fee, ts };
  }

  if (disc.equals(BOOK_EVENT_DISC.placed)) {
    const version = body.u8();
    checkVersion(version, "BookOrderPlaced");
    const ev: BookOrderPlacedEvent = {
      kind: "placed",
      version,
      market: body.pubkey(),
      seq: body.u64(),
      trader: body.pubkey(),
      side: body.u8(),
      priceTick: body.u16(),
      amount: body.u64(),
      ts: body.i64(),
    };
    body.done("BookOrderPlaced");
    return ev;
  }

  if (disc.equals(BOOK_EVENT_DISC.cancelled)) {
    const version = body.u8();
    checkVersion(version, "BookOrderCancelled");
    const ev: BookOrderCancelledEvent = {
      kind: "cancelled",
      version,
      market: body.pubkey(),
      seq: body.u64(),
      trader: body.pubkey(),
      refund: body.u64(),
      ts: body.i64(),
    };
    body.done("BookOrderCancelled");
    return ev;
  }

  return null;
}

/** Every book event in a transaction's inner instructions, in order. */
export function decodeBookEventsFromInner(
  innerData: Array<Buffer | Uint8Array>,
): BookEvent[] {
  const out: BookEvent[] = [];
  for (const d of innerData) {
    const ev = decodeBookEvent(d);
    if (ev) out.push(ev);
  }
  return out;
}
