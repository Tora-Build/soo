// Pull book history off the chain and into the store.
//
// ## The shape production Solana indexers use
//
// Two phases, not one:
//
//   BACKFILL  walk backwards from the tip to the beginning of the market, once.
//   TAIL      poll forwards from the newest signature already stored, forever.
//
// Conflating them is the usual mistake: a service that only ever polls the tip
// never learns what happened before it started, and one that always walks the
// whole history re-reads thousands of transactions to discover nothing. The
// cursor is what separates them, and it is why this is safe to restart.
//
// ## Polling, and what replaces it
//
// `getSignaturesForAddress` + `getTransaction` per signature is the portable
// way and it is what this does. It is also the slow way: the existing note in
// `fills.ts` measured a single cold request at ~2.7s on public devnet and a
// 429 on the second. That is survivable for one market on testnet and is not
// how a busy market should be indexed.
//
// The production answer is a stream rather than a poll — Geyser/Yellowstone
// gRPC, or a provider webhook (Helius, Triton) — which pushes transactions as
// they are confirmed instead of asking repeatedly. The write path here is
// deliberately the same either way: decode a transaction, produce rows, insert
// idempotently. Swapping the source means replacing `fetchRange` and nothing
// else, which is why that function is small and separate.
//
// ## Commitment
//
// `finalized`, not `confirmed`. A confirmed slot can still be dropped by the
// cluster, and an indexer that writes those has to be able to un-write them —
// reorg handling is a large amount of machinery to avoid needing. Finalized
// costs a few seconds of latency and removes the entire problem, and history
// is not latency-sensitive: nobody needs their fill in the ledger 3 seconds
// sooner than in 15.

import type { BookStore, BookEventRow, BookFillRow } from "./db.js";
import { decodeBookEventsFromTransaction } from "./decode-book-events.js";

/** The RPC surface this needs — kept narrow so tests can supply a fake. */
export interface IngestConnection {
  getSignaturesForAddress(
    address: unknown,
    options?: { limit?: number; before?: string; until?: string },
    commitment?: string,
  ): Promise<Array<{ signature: string; slot: number; err: unknown | null; blockTime?: number | null }>>;
  getTransaction(
    signature: string,
    options?: { maxSupportedTransactionVersion?: number; commitment?: string },
  ): Promise<unknown | null>;
}

export interface IngestOptions {
  /** The book PDA — events are emitted by instructions that touch it. */
  bookAddress: unknown;
  /** Market PDA, stored on every row so one database can hold many markets. */
  market: string;
  programId?: string;
  /** Signatures per RPC page. 1000 is the server-side maximum. */
  pageSize?: number;
  /** Stop after this many pages in one call, so a backfill can be resumed. */
  maxPages?: number;
}

export interface IngestResult {
  scanned: number;
  decoded: number;
  inserted: number;
  /** True once the walk reached the beginning of this market's history. */
  backfilled: boolean;
  /**
   * Signatures seen but not yet readable — confirmed, not finalized.
   *
   * Non-zero is normal at the tip and means the next pass will pick them up.
   * Persistently non-zero means the cursor is stuck, which is the failure mode
   * worth alerting on.
   */
  pending: number;
}

/**
 * One ingestion pass: tail forward if there is a cursor, backfill if not.
 *
 * Safe to call repeatedly. Re-ingesting a range inserts nothing new, because
 * every row is keyed on `(signature, event_index)`.
 */
export async function ingestOnce(
  store: BookStore,
  connection: IngestConnection,
  opts: IngestOptions,
): Promise<IngestResult> {
  const pageSize = opts.pageSize ?? 1000;
  const maxPages = opts.maxPages ?? 5;
  const cursor = store.getCursor(opts.market);

  let scanned = 0;
  let decoded = 0;
  let inserted = 0;
  let backfilled = cursor?.backfilled ?? false;
  let newestSeen: { signature: string; slot: number } | null = null;

  // Set when a signature could not be read this pass — almost always because
  // it is confirmed but not yet FINALIZED, since that is the commitment used.
  //
  // The cursor must not advance past it. An earlier version moved the cursor
  // to the newest signature SEEN rather than the newest PROCESSED, so a
  // transaction that was a few seconds too young got skipped, the next pass
  // asked only for signatures after it, and that history was lost permanently.
  // Re-reading a range is free — every write is keyed on
  // `(signature, event_index)` — so when in doubt, do not advance.
  let unread = false;

  // Tail: everything newer than what we already have. `until` is the newest
  // stored signature, and the RPC walks backwards from the tip and stops
  // there — so a quiet market costs one empty page rather than a full walk.
  //
  // Backfill: no cursor, so walk backwards from the tip using `before`,
  // paging until the market runs out.
  let before: string | undefined;
  const until = backfilled ? (cursor?.lastSignature ?? undefined) : undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const sigs = await connection.getSignaturesForAddress(
      opts.bookAddress,
      { limit: pageSize, before, until },
      "finalized",
    );
    if (sigs.length === 0) {
      // Nothing older left: the backfill has reached the beginning.
      if (!until) backfilled = true;
      break;
    }

    for (const sig of sigs) {
      scanned += 1;
      if (!newestSeen || sig.slot > newestSeen.slot) {
        newestSeen = { signature: sig.signature, slot: sig.slot };
      }
      // A failed transaction changed nothing, so it has no history to record.
      if (sig.err) continue;

      const tx = await connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "finalized",
      });
      if (!tx) {
        unread = true;
        continue;
      }

      const events = decodeBookEventsFromTransaction(tx, opts.programId);
      if (events.length === 0) continue;
      decoded += events.length;

      const { eventRows, fillRows } = toRows(
        events,
        sig.signature,
        sig.slot,
        sig.blockTime ?? null,
        opts.market,
      );
      inserted += store.putEvents(eventRows, fillRows);
    }

    before = sigs[sigs.length - 1]!.signature;
    if (sigs.length < pageSize) {
      if (!until) backfilled = true;
      break;
    }
  }

  // Advance only on a clean pass, and only forwards.
  //
  // FORWARDS, because a backfill page walks backwards and letting its oldest
  // signature set the tail cursor would re-read the same range forever.
  //
  // CLEAN, because anything unread this pass still needs reading — and the
  // cursor is precisely the thing that would stop us going back for it.
  const canAdvance = !unread && (newestSeen?.slot ?? 0) >= (cursor?.newestSlot ?? 0);
  store.setCursor(opts.market, {
    lastSignature: canAdvance
      ? (newestSeen?.signature ?? cursor?.lastSignature ?? null)
      : (cursor?.lastSignature ?? null),
    newestSlot: canAdvance
      ? Math.max(cursor?.newestSlot ?? 0, newestSeen?.slot ?? 0)
      : (cursor?.newestSlot ?? 0),
    // Only claim a completed backfill on a pass that read everything it saw.
    backfilled: backfilled && !unread,
  });

  return { scanned, decoded, inserted, backfilled, pending: unread ? 1 : 0 };
}

/** Decoded events -> storable rows. Pure, so it is testable without a chain. */
export function toRows(
  events: ReturnType<typeof decodeBookEventsFromTransaction>,
  signature: string,
  slot: number,
  blockTime: number | null,
  market: string,
): { eventRows: BookEventRow[]; fillRows: BookFillRow[] } {
  const eventRows: BookEventRow[] = [];
  const fillRows: BookFillRow[] = [];

  events.forEach((event, eventIndex) => {
    const base = { signature, eventIndex, slot, blockTime, market };
    if (event.kind === "book_filled") {
      eventRows.push({
        ...base,
        kind: "filled",
        trader: null,
        taker: event.taker,
        seq: null,
        side: event.taker_side,
        priceTick: null,
        amount: null,
        refund: null,
        fee: event.fee.toString(),
        ts: event.ts.toString(),
      });
      // One row per leg. A crossing order produces several, and the maker of
      // each needs to find their own — which is why this is not collapsed
      // into the event row.
      event.fills.forEach((f, fillIndex) => {
        fillRows.push({
          signature,
          eventIndex,
          fillIndex,
          market,
          taker: event.taker,
          maker: f.maker,
          makerSeq: f.maker_seq.toString(),
          priceTick: f.price_tick,
          amount: f.amount.toString(),
          slot,
          blockTime,
        });
      });
      return;
    }

    if (event.kind === "book_placed") {
      eventRows.push({
        ...base,
        kind: "placed",
        trader: event.trader,
        taker: null,
        seq: event.seq.toString(),
        side: event.side,
        priceTick: event.price_tick,
        amount: event.amount.toString(),
        refund: null,
        fee: null,
        ts: event.ts.toString(),
      });
      return;
    }

    eventRows.push({
      ...base,
      kind: "cancelled",
      trader: event.trader,
      taker: null,
      seq: event.seq.toString(),
      // A cancel carries only the sequence: the program has already freed the
      // node by the time it emits. Side and price are recoverable by joining
      // to this order's `placed` row, which the store keeps.
      side: null,
      priceTick: null,
      amount: null,
      refund: event.refund.toString(),
      fee: null,
      ts: event.ts.toString(),
    });
  });

  return { eventRows, fillRows };
}
