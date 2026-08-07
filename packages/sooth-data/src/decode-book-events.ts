// Decoder for the redesigned book's events (`docs/design/orderbook-redesign.md`).
//
// Deliberately a second implementation rather than an import from
// `@sooth/sdk-solana`: this service has no SDK dependency, which keeps the
// indexer deployable without the whole client toolchain. The cost is that the
// two decoders must agree, so both are pinned against captured on-chain bytes
// rather than against each other.
//
// ## Framing
//
//   [8-byte Anchor CPI-event tag][8-byte event discriminator][borsh body]
//
// The payload arrives as an inner instruction because the program emits it with
// `emit_cpi!` — a self-CPI. Program logs are truncated and unreliable across
// RPC providers; an inner instruction is real transaction data.
//
// ## Versioning
//
// Every book event carries a `version` byte as its FIRST field, and this
// decoder REJECTS an unknown version rather than guessing. The legacy
// `OrdersFilled` has no version, and both failure modes are live: adding one
// field 500s the endpoint, and renaming the event yields an empty list with
// HTTP 200 — silent data loss.

import { decodeBase58 } from "./base58.js";
import { PROGRAM_IDS } from "./config.js";

/** Anchor's marker for a self-CPI event instruction. */
export const CPI_EVENT_TAG = Uint8Array.from([
  228, 69, 165, 46, 81, 203, 154, 29,
]);

/** The only book-event version this decoder understands. */
export const BOOK_EVENT_VERSION = 1;

/** sha256("event:<Name>")[..8] */
export const BOOK_FILLED_DISCRIMINATOR = Uint8Array.from([
  134, 27, 55, 180, 174, 105, 208, 243,
]);
export const BOOK_ORDER_PLACED_DISCRIMINATOR = Uint8Array.from([
  249, 106, 60, 191, 67, 209, 179, 21,
]);
export const BOOK_ORDER_CANCELLED_DISCRIMINATOR = Uint8Array.from([
  30, 121, 53, 249, 40, 18, 202, 9,
]);

/** One share, in USDC base units — the unit the book speaks. */
export const ONE_SHARE_BASE = 1_000_000n;
/** Base units → WAD, so book amounts are comparable with legacy ones. */
export const BASE_TO_WAD = 1_000_000_000_000n;

export type BookFillRecord = {
  maker: string;
  maker_seq: bigint;
  /** Execution price — the MAKER's tick, i.e. the YES price on the unified axis. */
  price_tick: number;
  /** USDC base units. */
  amount: bigint;
};

export type BookFilledEvent = {
  kind: "book_filled";
  version: number;
  market: string;
  taker: string;
  taker_side: number;
  fills: BookFillRecord[];
  fee: bigint;
  ts: bigint;
};

export type BookOrderPlacedEvent = {
  kind: "book_placed";
  version: number;
  market: string;
  seq: bigint;
  trader: string;
  side: number;
  price_tick: number;
  amount: bigint;
  ts: bigint;
};

export type BookOrderCancelledEvent = {
  kind: "book_cancelled";
  version: number;
  market: string;
  seq: bigint;
  trader: string;
  refund: bigint;
  ts: bigint;
};

export type BookEvent =
  | BookFilledEvent
  | BookOrderPlacedEvent
  | BookOrderCancelledEvent;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (data[i] !== prefix[i]) return false;
  }
  return true;
}

class Reader {
  private offset: number;
  constructor(
    private readonly bytes: Uint8Array,
    start = 0,
  ) {
    this.offset = start;
  }
  private take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) {
      throw new Error("book event payload truncated");
    }
    const slice = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }
  u8(): number {
    return this.take(1)[0]!;
  }
  u16(): number {
    const b = this.take(2);
    return b[0]! | (b[1]! << 8);
  }
  u32(): number {
    const b = this.take(4);
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }
  u64(): bigint {
    const b = this.take(8);
    let v = 0n;
    for (let i = 7; i >= 0; i -= 1) v = (v << 8n) | BigInt(b[i]!);
    return v;
  }
  i64(): bigint {
    const v = this.u64();
    return v >= 1n << 63n ? v - (1n << 64n) : v;
  }
  pubkey(): string {
    return encodeBase58(this.take(32));
  }
  atEnd(): boolean {
    return this.offset === this.bytes.length;
  }
}

// Minimal base58 encode — `base58.ts` only exposes a decoder.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58[digits[i]!];
  return out;
}

function checkVersion(v: number, what: string): void {
  // Reject rather than guess. A v2 event read by a v1 decoder produces
  // plausible garbage, not an error — which is worse than a 500.
  if (v !== BOOK_EVENT_VERSION) {
    throw new Error(
      `${what}: unsupported book event version ${v} (this build handles ${BOOK_EVENT_VERSION})`,
    );
  }
}

/**
 * Decode one inner-instruction payload, or `null` if it is not a book event.
 *
 * `null` for "not ours", a throw for "ours but malformed" — so an unrelated
 * inner instruction is skipped quietly while a real layout drift is loud.
 */
export function decodeBookEventInstructionData(
  data: Uint8Array,
): BookEvent | null {
  if (data.length < 16) return null;
  if (!startsWith(data, CPI_EVENT_TAG)) return null;

  const disc = data.slice(8, 16);
  const r = new Reader(data, 16);

  if (bytesEqual(disc, BOOK_FILLED_DISCRIMINATOR)) {
    const version = r.u8();
    checkVersion(version, "BookFilled");
    const market = r.pubkey();
    const taker = r.pubkey();
    const taker_side = r.u8();
    const n = r.u32();
    const fills: BookFillRecord[] = [];
    for (let i = 0; i < n; i += 1) {
      fills.push({
        maker: r.pubkey(),
        maker_seq: r.u64(),
        price_tick: r.u16(),
        amount: r.u64(),
      });
    }
    const fee = r.u64();
    const ts = r.i64();
    if (!r.atEnd()) throw new Error("BookFilled: trailing bytes");
    return { kind: "book_filled", version, market, taker, taker_side, fills, fee, ts };
  }

  if (bytesEqual(disc, BOOK_ORDER_PLACED_DISCRIMINATOR)) {
    const version = r.u8();
    checkVersion(version, "BookOrderPlaced");
    const ev: BookOrderPlacedEvent = {
      kind: "book_placed",
      version,
      market: r.pubkey(),
      seq: r.u64(),
      trader: r.pubkey(),
      side: r.u8(),
      price_tick: r.u16(),
      amount: r.u64(),
      ts: r.i64(),
    };
    if (!r.atEnd()) throw new Error("BookOrderPlaced: trailing bytes");
    return ev;
  }

  if (bytesEqual(disc, BOOK_ORDER_CANCELLED_DISCRIMINATOR)) {
    const version = r.u8();
    checkVersion(version, "BookOrderCancelled");
    const ev: BookOrderCancelledEvent = {
      kind: "book_cancelled",
      version,
      market: r.pubkey(),
      seq: r.u64(),
      trader: r.pubkey(),
      refund: r.u64(),
      ts: r.i64(),
    };
    if (!r.atEnd()) throw new Error("BookOrderCancelled: trailing bytes");
    return ev;
  }

  return null;
}

type TxLike = {
  transaction?: { message?: { accountKeys?: unknown[] } };
  meta?: {
    innerInstructions?: Array<{
      index?: number;
      instructions?: Array<{ programIdIndex?: number; data?: string }>;
    }> | null;
  } | null;
};

/**
 * The account at `index`, whatever shape the RPC returned it in.
 *
 * Three encodings reach here and they are NOT interchangeable:
 *
 *   "json"        -> a base58 string
 *   "jsonParsed"  -> { pubkey: "..." }
 *   default       -> a PublicKey instance, from `connection.getTransaction`
 *                    without an explicit encoding
 *
 * The third was missing, and the failure is silent in the worst way: the
 * program-id comparison finds `null`, every instruction is skipped, and the
 * decoder reports zero events for a transaction full of them. An indexer built
 * on that stores nothing and looks like it is working.
 */
function accountKeyAt(tx: TxLike, index: number): string | null {
  const key = tx.transaction?.message?.accountKeys?.[index];
  if (typeof key === "string") return key;
  if (key && typeof key === "object") {
    if ("pubkey" in key) {
      const p = (key as { pubkey?: unknown }).pubkey;
      if (typeof p === "string") return p;
      // jsonParsed can itself nest a PublicKey.
      if (p && typeof (p as { toBase58?: unknown }).toBase58 === "function") {
        return (p as { toBase58(): string }).toBase58();
      }
      return null;
    }
    if (typeof (key as { toBase58?: unknown }).toBase58 === "function") {
      return (key as { toBase58(): string }).toBase58();
    }
  }
  return null;
}

/**
 * Every book event in a transaction's inner instructions.
 *
 * Filtered on the emitting program, which for a self-CPI is `sooth_core`
 * itself. Note the authenticity story is weaker than the legacy path's
 * `isBuyParent` check and does not need to be stronger: these events are
 * emitted by the program under its own id, so a forgery would require the
 * program to emit it.
 */
export function decodeBookEventsFromTransaction(
  tx: unknown,
  programId: string = PROGRAM_IDS.SOOTH_CORE,
): BookEvent[] {
  const t = tx as TxLike;
  const groups = t.meta?.innerInstructions ?? [];
  const out: BookEvent[] = [];
  for (const group of groups) {
    for (const ix of group.instructions ?? []) {
      if (typeof ix.programIdIndex !== "number" || typeof ix.data !== "string") {
        continue;
      }
      if (accountKeyAt(t, ix.programIdIndex) !== programId) continue;
      const ev = decodeBookEventInstructionData(decodeBase58(ix.data));
      if (ev) out.push(ev);
    }
  }
  return out;
}
