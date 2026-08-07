// Client for the redesigned orderbook (`docs/design/orderbook-redesign.md`).
//
// Three things live here: the PDA, instruction builders, and a decoder that
// turns the raw account into a usable snapshot.
//
// ## Why this is hand-written rather than Anchor-generated
//
// The `Book` account is loaded on-chain by casting its bytes in place — there
// is no `#[account]` type for Anchor to size or deserialize, and the account's
// length changes over the market's life. So the layout is mirrored here
// deliberately, with the offsets derived from named constants rather than
// spelled as literals, and `bookLayoutSelfCheck()` re-derives them so a drift
// in the Rust struct shows up as a failing assertion rather than silently
// mis-parsed orders.
//
// ## What replaced the matching driver
//
// The old `matching-driver.ts` had to predict the exact crossing sequence
// off-chain and pass one 3-account bundle per fill in `remaining_accounts`,
// because the program could not discover makers. That is where audit finding
// H1 comes from: batches planned against a book that has since moved select
// stale makers, and every batch after the first fails.
//
// Here the program walks its own book. A taker sends one instruction with a
// `matchLimit` and the on-chain matcher does the rest, so there is nothing to
// precompute, nothing to go stale, and no H1.

import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

import {
  deriveMarketVaultAta,
  deriveProtocolConfigPda,
  deriveVaultAuthorityPda,
  marketFeePoolPda,
  type MarketId,
  type ProgramIds,
} from "../pdas.js";

// ── Layout, mirrored from `book/arena.rs` + `book/account.rs` ─────────────

export const BOOK_SEED = "book";
export const DISCRIMINATOR_LEN = 8;
export const HEADER_LEN = 128;
export const BLOCKS_OFFSET = DISCRIMINATOR_LEN + HEADER_LEN;
export const BLOCK_SIZE = 64;
/** `arena::NIL` — u32::MAX, not 0, because 0 is a valid block index. */
export const NIL = 0xffffffff;
/**
 * `arena::MAX_ORDERS` — a ceiling on BLOCKS, which orders and seats share.
 *
 * A position holder costs one block and a maker costs two (a seat plus the
 * order), so this is not a user count and not an order count. Mirrored by hand
 * from the Rust, and pinned by `book-constants.test.ts` so the two cannot
 * drift.
 */
export const MAX_ORDERS = 4096;

export const SIDE_BID = 0; // buy YES
export const SIDE_ASK = 1; // sell YES == buy NO at (1 - p)
/** One share in USDC base units; redeems for 1.00. */
export const ONE_SHARE = 1_000_000n;
export const NUM_TICKS = 1000;

export const KIND_ORDER = 0;
export const KIND_SEAT = 1;

const HEADER = {
  market: 8,
  nextSeq: 8 + 32,
  freeHead: 8 + 40,
  bidsHead: 8 + 44,
  asksHead: 8 + 48,
  blockCount: 8 + 52,
  orderCount: 8 + 56,
  seatsHead: 8 + 60,
  bump: 8 + 64,
} as const;

/** `OrderNode` field offsets within a block. */
const ORDER = {
  amount: 0,
  trader: 8,
  seq: 40,
  next: 48,
  prev: 52,
  priceTick: 56,
  side: 58,
  flags: 59,
} as const;

/** `SeatNode` — same block, distinguished by the byte at `ORDER.flags`. */
const SEAT = {
  credit: 0,
  trader: 8,
  net: 40,
  next: 48,
  kind: 59,
} as const;

/**
 * Assert the mirrored layout is internally consistent.
 *
 * These offsets are the one place this package can silently disagree with the
 * program: a wrong offset does not throw, it returns plausible-looking orders
 * with the wrong prices. `SEAT.kind` sharing `ORDER.flags` is the load-bearing
 * one — it is how a block is identified before it is interpreted.
 */
export function bookLayoutSelfCheck(): void {
  if (SEAT.kind !== ORDER.flags) {
    throw new Error("SeatNode.kind must share an offset with OrderNode.flags");
  }
  if (BLOCKS_OFFSET % 8 !== 0 || BLOCK_SIZE % 8 !== 0) {
    throw new Error("book layout must stay 8-byte aligned");
  }
  if (HEADER.bump + 1 > BLOCKS_OFFSET) {
    throw new Error("header fields overflow the header region");
  }
}
bookLayoutSelfCheck();

// ── PDA ───────────────────────────────────────────────────────────────────

/**
 * Anchor's `#[event_cpi]` authority PDA. `emit_cpi!` self-invokes the program
 * with this as a signer, which is what turns an event into an inner
 * instruction instead of a log line.
 */
export function eventAuthorityPda(programs: ProgramIds): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programs.soothCore,
  );
}

export function bookPda(
  marketId: MarketId,
  programs: ProgramIds,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BOOK_SEED), Buffer.from(marketId)],
    programs.soothCore,
  );
}

/** Account bytes needed for `capacity` blocks. */
export function bookSpace(capacity: number): number {
  return BLOCKS_OFFSET + capacity * BLOCK_SIZE;
}

// ── Instruction builders ──────────────────────────────────────────────────

/** sha256("global:<ix>")[..8] */
const DISC = {
  init: Buffer.from([71, 248, 196, 177, 97, 141, 21, 244]),
  grow: Buffer.from([243, 106, 1, 169, 190, 123, 193, 203]),
  place: Buffer.from([166, 211, 8, 100, 130, 30, 212, 203]),
  cancel: Buffer.from([188, 129, 42, 161, 150, 10, 3, 59]),
  withdraw: Buffer.from([138, 127, 40, 44, 99, 47, 107, 106]),
} as const;

export interface BookRefs {
  marketId: MarketId;
  marketPda: PublicKey;
  usdcMint: PublicKey;
  programs: ProgramIds;
}

const key = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({
  pubkey,
  isSigner,
  isWritable,
});

function u16Ix(disc: Buffer, value: number): Buffer {
  const d = Buffer.alloc(10);
  disc.copy(d, 0);
  d.writeUInt16LE(value, 8);
  return d;
}

/**
 * Heap the `book_init` transaction must request.
 *
 * The program's bump allocator starts at the TOP of a 256 KiB heap, but the
 * runtime maps only 32 KiB unless the transaction asks for more. `book_init`
 * heap-allocates (Anchor's `Box<Account<Market>>`) before the handler body
 * runs, so without this the very first allocation writes ~200 bytes below
 * 0x300040000 and traps:
 *
 *   Program ... consumed 215 of 200000 compute units
 *   Program ... failed: Access violation in heap section at address 0x30003ff38
 *
 * 215 CU is the tell — the program never reached its own code, which is why
 * the failure carries no program log and no Anchor error code.
 */
export const BOOK_INIT_HEAP_BYTES = 256 * 1024;

/**
 * Cancels that fit in one transaction alongside the trailing withdraw.
 *
 * Measured, not guessed. A transaction de-duplicates its account list, so
 * every cancel after the first adds only ~24 bytes — its header, a few account
 * indices and the 8-byte sequence:
 *
 *    5 cancels ->  634 bytes
 *   20 cancels ->  994 bytes
 *   25 cancels -> 1114 bytes
 *   30 cancels -> over the 1232-byte limit
 *
 * 24 leaves room for the ATA pre-instruction and the compute-budget preamble
 * without sitting on the edge.
 */
export const MAX_CANCELS_PER_TX = 24;

/**
 * `book_init` plus the heap-frame request it cannot run without.
 *
 * Prefer this over calling `buildBookInit` directly: the bare instruction
 * always fails on its own. `buildBookInit` stays exported for callers that
 * assemble their own transaction and supply the heap frame themselves.
 */
export function buildBookInitIxs(
  refs: BookRefs,
  payer: PublicKey,
  initialCapacity: number,
): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.requestHeapFrame({ bytes: BOOK_INIT_HEAP_BYTES }),
    buildBookInit(refs, payer, initialCapacity),
  ];
}

export function buildBookInit(
  refs: BookRefs,
  payer: PublicKey,
  initialCapacity: number,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: refs.programs.soothCore,
    keys: [
      key(bookPda(refs.marketId, refs.programs)[0], true),
      key(refs.marketPda, false),
      key(payer, true, true),
      key(SystemProgram.programId, false),
    ],
    data: u16Ix(DISC.init, initialCapacity),
  });
}

export function buildBookGrow(
  refs: BookRefs,
  payer: PublicKey,
  wantedCapacity: number,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: refs.programs.soothCore,
    keys: [
      key(bookPda(refs.marketId, refs.programs)[0], true),
      key(refs.marketPda, false),
      key(payer, true, true),
      key(SystemProgram.programId, false),
    ],
    data: u16Ix(DISC.grow, wantedCapacity),
  });
}

export interface PlaceArgs {
  side: number;
  /** Limit price in ticks, 1..999. Fills execute at the maker's price. */
  limitTick: number;
  /** Size in USDC base units; `ONE_SHARE` is one share. */
  amount: bigint;
  /** Maximum resting orders to cross. Bounds compute, not correctness. */
  matchLimit: number;
  /** Rest whatever does not fill. */
  postRemainder: boolean;
}

export function buildBookPlace(
  refs: BookRefs,
  taker: PublicKey,
  args: PlaceArgs,
): TransactionInstruction {
  if (args.limitTick <= 0 || args.limitTick >= NUM_TICKS) {
    throw new Error(`limitTick must be 1..${NUM_TICKS - 1}, got ${args.limitTick}`);
  }
  if (args.side !== SIDE_BID && args.side !== SIDE_ASK) {
    throw new Error(`side must be 0 (bid) or 1 (ask), got ${args.side}`);
  }
  const d = Buffer.alloc(8 + 1 + 2 + 8 + 4 + 1);
  DISC.place.copy(d, 0);
  let o = 8;
  d.writeUInt8(args.side, o);
  o += 1;
  d.writeUInt16LE(args.limitTick, o);
  o += 2;
  d.writeBigUInt64LE(args.amount, o);
  o += 8;
  d.writeUInt32LE(args.matchLimit, o);
  o += 4;
  d.writeUInt8(args.postRemainder ? 1 : 0, o);

  const { marketId, programs, usdcMint } = refs;
  return new TransactionInstruction({
    programId: programs.soothCore,
    keys: [
      key(bookPda(marketId, programs)[0], true),
      key(refs.marketPda, false),
      key(deriveVaultAuthorityPda(marketId, programs)[0], false),
      key(deriveMarketVaultAta(marketId, usdcMint, programs), true),
      key(getAssociatedTokenAddressSync(usdcMint, taker), true),
      key(marketFeePoolPda(marketId, programs)[0], true),
      key(deriveProtocolConfigPda(programs)[0], false),
      key(taker, false, true),
      key(TOKEN_PROGRAM_ID, false),
      // #[event_cpi] tail — see eventAuthorityPda.
      key(eventAuthorityPda(programs)[0], false),
      key(programs.soothCore, false),
    ],
    data: d,
  });
}

export function buildBookCancel(
  refs: BookRefs,
  owner: PublicKey,
  orderSeq: bigint,
): TransactionInstruction {
  const d = Buffer.alloc(16);
  DISC.cancel.copy(d, 0);
  d.writeBigUInt64LE(orderSeq, 8);
  return new TransactionInstruction({
    programId: refs.programs.soothCore,
    keys: [
      key(bookPda(refs.marketId, refs.programs)[0], true),
      key(refs.marketPda, false),
      key(owner, false, true),
      key(eventAuthorityPda(refs.programs)[0], false),
      key(refs.programs.soothCore, false),
    ],
    data: d,
  });
}

export function buildBookWithdraw(
  refs: BookRefs,
  user: PublicKey,
): TransactionInstruction {
  const { marketId, programs, usdcMint } = refs;
  return new TransactionInstruction({
    programId: programs.soothCore,
    keys: [
      key(bookPda(marketId, programs)[0], true),
      key(refs.marketPda, false),
      key(deriveVaultAuthorityPda(marketId, programs)[0], false),
      key(deriveMarketVaultAta(marketId, usdcMint, programs), true),
      key(getAssociatedTokenAddressSync(usdcMint, user), true),
      key(user, false, true),
      key(TOKEN_PROGRAM_ID, false),
    ],
    data: Buffer.from(DISC.withdraw),
  });
}

// ── Decoding ──────────────────────────────────────────────────────────────

export interface BookOrder {
  /** Block index. Useful for debugging; not stable across cancels. */
  index: number;
  /** Monotonic per-market sequence — the id `buildBookCancel` takes. */
  seq: bigint;
  trader: string;
  priceTick: number;
  side: number;
  /** Unfilled size, USDC base units. */
  amount: bigint;
}

export interface BookSeat {
  trader: string;
  /** Withdrawable USDC base units. */
  credit: bigint;
  /** Signed position: `> 0` long YES, `< 0` long NO. */
  net: bigint;
}

export interface BookSnapshot {
  market: string;
  nextSeq: bigint;
  orderCount: number;
  blockCount: number;
  capacity: number;
  /** Best bid first: highest price, then earliest. */
  bids: BookOrder[];
  /** Best ask first: lowest price, then earliest. */
  asks: BookOrder[];
  seats: BookSeat[];
}

function blockAt(data: Buffer, index: number): Buffer {
  const start = BLOCKS_OFFSET + index * BLOCK_SIZE;
  return data.subarray(start, start + BLOCK_SIZE);
}

function readOrder(data: Buffer, index: number): BookOrder {
  const b = blockAt(data, index);
  return {
    index,
    seq: b.readBigUInt64LE(ORDER.seq),
    trader: new PublicKey(b.subarray(ORDER.trader, ORDER.trader + 32)).toBase58(),
    priceTick: b.readUInt16LE(ORDER.priceTick),
    side: b.readUInt8(ORDER.side),
    amount: b.readBigUInt64LE(ORDER.amount),
  };
}

/**
 * Walk an intrusive list, bounded by `blockCount`.
 *
 * The bound is not defensive decoration: a corrupt or truncated account could
 * otherwise send this into an unbounded loop, and this code runs in an indexer
 * and a browser, not a validator.
 */
function walk(
  data: Buffer,
  head: number,
  blockCount: number,
  nextOffset: number,
  read: (i: number) => BookOrder | BookSeat,
): Array<BookOrder | BookSeat> {
  const out: Array<BookOrder | BookSeat> = [];
  let cursor = head;
  let guard = 0;
  while (cursor !== NIL && guard <= blockCount) {
    if (cursor >= blockCount) {
      throw new Error(`book list points past block_count (${cursor} >= ${blockCount})`);
    }
    out.push(read(cursor));
    cursor = blockAt(data, cursor).readUInt32LE(nextOffset);
    guard += 1;
  }
  if (guard > blockCount) {
    throw new Error("book list is cyclic");
  }
  return out;
}

export function decodeBook(data: Buffer | Uint8Array): BookSnapshot {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < BLOCKS_OFFSET) {
    throw new Error(`book account too small: ${buf.length} < ${BLOCKS_OFFSET}`);
  }
  const blockCount = buf.readUInt32LE(HEADER.blockCount);
  const capacity = Math.floor((buf.length - BLOCKS_OFFSET) / BLOCK_SIZE);
  if (blockCount > capacity) {
    throw new Error(`block_count ${blockCount} exceeds capacity ${capacity}`);
  }

  const bids = walk(
    buf,
    buf.readUInt32LE(HEADER.bidsHead),
    blockCount,
    ORDER.next,
    (i) => readOrder(buf, i),
  ) as BookOrder[];
  const asks = walk(
    buf,
    buf.readUInt32LE(HEADER.asksHead),
    blockCount,
    ORDER.next,
    (i) => readOrder(buf, i),
  ) as BookOrder[];
  const seats = walk(buf, buf.readUInt32LE(HEADER.seatsHead), blockCount, SEAT.next, (i) => {
    const b = blockAt(buf, i);
    return {
      trader: new PublicKey(b.subarray(SEAT.trader, SEAT.trader + 32)).toBase58(),
      credit: b.readBigUInt64LE(SEAT.credit),
      net: b.readBigInt64LE(SEAT.net),
    };
  }) as BookSeat[];

  return {
    market: new PublicKey(buf.subarray(HEADER.market, HEADER.market + 32)).toBase58(),
    nextSeq: buf.readBigUInt64LE(HEADER.nextSeq),
    orderCount: buf.readUInt32LE(HEADER.orderCount),
    blockCount,
    capacity,
    bids,
    asks,
    seats,
  };
}

/** Aggregate a side into a price ladder, best first. */
export function ladder(orders: BookOrder[]): Array<{ tick: number; amount: bigint }> {
  const rows: Array<{ tick: number; amount: bigint }> = [];
  for (const o of orders) {
    const last = rows[rows.length - 1];
    if (last && last.tick === o.priceTick) last.amount += o.amount;
    else rows.push({ tick: o.priceTick, amount: o.amount });
  }
  return rows;
}

/** A trader's seat, or a zeroed one if they have never traded. */
export function seatOf(snapshot: BookSnapshot, trader: string): BookSeat {
  return (
    snapshot.seats.find((s) => s.trader === trader) ?? {
      trader,
      credit: 0n,
      net: 0n,
    }
  );
}
