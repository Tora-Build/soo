// Turn a decoded `Book` account into what the orderbook UI renders.
//
// This replaces two things at once.
//
// **The 999-call ladder scan.** `useOrderbook` walks every tick from 999 down
// to 1 issuing `getOrdersAtTick` through a multicall, because the legacy book
// stores one account per price level and there is no way to enumerate them.
// The redesigned book is a single account, so the whole ladder is one
// `getAccountInfo` and a decode.
//
// **The complement flip.** The legacy book is two-sided: side 1 quotes its own
// price and side 0 quotes `1 - p`, so every display surface has to remember to
// invert one of them. The new book quotes a single unified YES axis — a bid at
// tick 400 and an ask at tick 400 are both "YES at 0.40", differing only in
// direction. `tickToYesPrice` collapses to a division.
//
// Everything here is pure: it takes a `BookSnapshot` and returns view models,
// so it is unit-testable without a chain, a wallet, or React.

import type { BookOrder, BookSeat, BookSnapshot } from "@sooth/sdk-solana";

/** Ticks per unit price, mirroring the program. */
export const NUM_TICKS = 1000;
/** One share in USDC base units — the unit the redesigned book counts in. */
export const ONE_SHARE_BASE = 1_000_000n;

export const SIDE_BID = 0;
export const SIDE_ASK = 1;

/**
 * YES price for a tick on the unified axis.
 *
 * No side parameter, deliberately. On the legacy book this needed one, and
 * forgetting it rendered the wrong side of the market at a glance-identical
 * number. Here both sides quote the same axis, so a side argument could only
 * ever reintroduce that bug.
 */
export function yesPrice(tick: number): number {
  return Math.max(0, Math.min(1, tick / NUM_TICKS));
}

/** Shares, as a decimal number, from USDC base units. */
export function toShares(baseUnits: bigint): number {
  return Number(baseUnits) / Number(ONE_SHARE_BASE);
}

export interface LadderRow {
  tick: number;
  price: number;
  /** Total resting size at this level, base units. */
  amount: bigint;
  shares: number;
  /** Cumulative size from the best price down to this level. */
  cumulative: bigint;
  orderCount: number;
}

/**
 * Aggregate one side into price levels, best first.
 *
 * The snapshot is already sorted best-first by the program's intrusive list, so
 * this is a single pass — it must not re-sort, or it would silently discard the
 * time priority the on-chain matcher actually uses.
 */
export function toLadder(orders: BookOrder[], maxRows = 12): LadderRow[] {
  const rows: LadderRow[] = [];
  let cumulative = 0n;
  for (const o of orders) {
    const last = rows[rows.length - 1];
    if (last && last.tick === o.priceTick) {
      last.amount += o.amount;
      last.shares = toShares(last.amount);
      last.orderCount += 1;
      cumulative += o.amount;
      last.cumulative = cumulative;
      continue;
    }
    if (rows.length >= maxRows) break;
    cumulative += o.amount;
    rows.push({
      tick: o.priceTick,
      price: yesPrice(o.priceTick),
      amount: o.amount,
      shares: toShares(o.amount),
      cumulative,
      orderCount: 1,
    });
  }
  return rows;
}

export interface BookView {
  bids: LadderRow[];
  asks: LadderRow[];
  /** Midpoint of best bid and best ask, or null when either side is empty. */
  midPrice: number | null;
  /** Best ask minus best bid, in price units. */
  spread: number | null;
  orderCount: number;
  /** Live orders against the arena's block ceiling. */
  capacityUsed: number;
}

export function toBookView(snapshot: BookSnapshot, maxRows = 12): BookView {
  const bids = toLadder(snapshot.bids, maxRows);
  const asks = toLadder(snapshot.asks, maxRows);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  return {
    bids,
    asks,
    midPrice: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
    spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
    orderCount: snapshot.orderCount,
    capacityUsed: snapshot.capacity > 0 ? snapshot.blockCount / snapshot.capacity : 0,
  };
}

export interface MyOrder {
  /** The real on-chain sequence — what `book_cancel` takes. */
  seq: bigint;
  /** Stable id for React keys. No longer synthesised from side and tick. */
  id: string;
  side: number;
  tick: number;
  price: number;
  amount: bigint;
  shares: number;
  isBid: boolean;
}

/**
 * A trader's resting orders.
 *
 * Each carries its real `seq`, so cancelling names an exact order. The legacy
 * UI synthesised `"${side}:${tick}"` ids when it did not know a real one and
 * regex-parsed them back — a path that resolved `"unknown-400"` to the NO side
 * because "unknown" contains "no", and truncated `"yes-12345"` to tick 345.
 * Both are gone by construction here: there is nothing to synthesise.
 */
export function myOrders(snapshot: BookSnapshot, trader: string): MyOrder[] {
  const mine: MyOrder[] = [];
  for (const [side, orders] of [
    [SIDE_BID, snapshot.bids],
    [SIDE_ASK, snapshot.asks],
  ] as const) {
    for (const o of orders) {
      if (o.trader !== trader) continue;
      mine.push({
        seq: o.seq,
        id: o.seq.toString(),
        side,
        tick: o.priceTick,
        price: yesPrice(o.priceTick),
        amount: o.amount,
        shares: toShares(o.amount),
        isBid: side === SIDE_BID,
      });
    }
  }
  // Earliest first, matching the order the matcher would consume them.
  return mine.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
}

export interface MyPosition {
  /** Signed: positive is long YES, negative long NO. */
  net: bigint;
  netShares: number;
  side: "YES" | "NO" | "FLAT";
  /** Withdrawable balance, base units — cancelled escrow and fill proceeds. */
  credit: bigint;
  creditUsdc: number;
}

/**
 * A trader's position and withdrawable credit.
 *
 * Both live in the book account's seat, so this needs no extra fetch — the
 * same `getAccountInfo` that produced the ladder produced this.
 */
/**
 * The two legs of a match, in USDC base units — a mirror of `leg_costs`.
 *
 * A YES share and a NO share sum to exactly 1, so a fill at tick `t` splits
 * `amount` into `t/1000` from the bid and `(1000-t)/1000` from the ask. The
 * MAKER leg floors and the taker leg takes the remainder, so the pair sums to
 * `amount` exactly. Flooring both would let the pair come to `amount - 1` and
 * bleed the vault by one base unit per fill.
 *
 * Returned as `[bid, ask]`.
 */
export function legCosts(
  priceTick: number,
  amount: bigint,
  takerSide: number,
): [bigint, bigint] {
  const tick = BigInt(priceTick);
  if (tick <= 0n || tick >= BigInt(NUM_TICKS)) {
    throw new RangeError(`tick ${priceTick} outside 1..${NUM_TICKS - 1}`);
  }
  const takerIsBid = takerSide === SIDE_BID;
  const makerTicks = takerIsBid ? BigInt(NUM_TICKS) - tick : tick;
  const makerCost = (amount * makerTicks) / BigInt(NUM_TICKS);
  const takerCost = amount - makerCost;
  return takerIsBid ? [takerCost, makerCost] : [makerCost, takerCost];
}

/**
 * USDC locked behind a single resting order — a mirror of `escrow_of`.
 *
 * A maker posts only their own leg; the counterparty brings the other. So a
 * bid at 0.40 for 10 shares locks 4 USDC, not 10.
 */
export function escrowOf(order: {
  priceTick: number;
  amount: bigint;
  side: number;
}): bigint {
  const [bid, ask] = legCosts(order.priceTick, order.amount, order.side);
  return order.side === SIDE_BID ? bid : ask;
}

/**
 * A trader's whole standing in one book: withdrawable credit, escrow locked
 * behind resting orders, and net share position.
 *
 * The demo's Trading Account card hardcoded `reserved = 0`, so collateral sat
 * in the book invisibly — a trader who placed orders watched their wallet
 * balance drop with nothing to account for it.
 */
export function myAccount(
  snapshot: BookSnapshot,
  trader: string,
): { credit: bigint; escrow: bigint; net: bigint; openOrders: number } {
  const pos = myPosition(snapshot, trader);
  let escrow = 0n;
  let openOrders = 0;
  for (const side of [snapshot.bids, snapshot.asks]) {
    for (const o of side) {
      if (o.trader !== trader) continue;
      escrow += escrowOf(o);
      openOrders += 1;
    }
  }
  return { credit: pos.credit, escrow, net: pos.net, openOrders };
}

/**
 * Would this order cross one of the trader's OWN resting orders?
 *
 * The matcher never trades a trader against themselves. It steps over their
 * own orders to reach everyone else's, and whatever is left is CANCELLED
 * rather than rested, so the book cannot end up crossed against them.
 *
 * That is the right behaviour and it is invisible: the transaction succeeds,
 * nothing rests, and the order simply never appears. Knowing in advance lets
 * the UI say so instead of leaving the trader to wonder.
 *
 * Returns the size that would be cancelled if nothing else filled first —
 * a worst case, since liquidity from other traders is consumed before the
 * remainder is dropped.
 */
export function selfCrossExposure(
  snapshot: BookSnapshot,
  trader: string,
  side: number,
  limitTick: number,
  amount: bigint,
): { crosses: boolean; ownAmount: bigint; othersAmount: bigint } {
  const opposite = side === SIDE_BID ? snapshot.asks : snapshot.bids;
  let ownAmount = 0n;
  let othersAmount = 0n;
  for (const o of opposite) {
    const crosses =
      side === SIDE_BID ? o.priceTick <= limitTick : o.priceTick >= limitTick;
    // The side list is price-ordered, so the first non-crossing order ends it.
    if (!crosses) break;
    if (o.trader === trader) ownAmount += o.amount;
    else othersAmount += o.amount;
  }
  // Only a remainder gets cancelled, so an order fully covered by other
  // traders' liquidity is never affected however much of its own it crosses.
  const crosses = ownAmount > 0n && othersAmount < amount;
  return { crosses, ownAmount, othersAmount };
}

export function myPosition(snapshot: BookSnapshot, trader: string): MyPosition {
  const seat: BookSeat = snapshot.seats.find((s) => s.trader === trader) ?? {
    trader,
    credit: 0n,
    net: 0n,
  };
  return {
    net: seat.net,
    netShares: toShares(seat.net < 0n ? -seat.net : seat.net) * (seat.net < 0n ? -1 : 1),
    side: seat.net > 0n ? "YES" : seat.net < 0n ? "NO" : "FLAT",
    credit: seat.credit,
    creditUsdc: Number(seat.credit) / Number(ONE_SHARE_BASE),
  };
}

/**
 * Cost of a market order that sweeps the book, in base units.
 *
 * Walks the same side the on-chain matcher would, at the same prices, so a
 * quote shown to a user matches what they will pay — the legacy UI could not
 * do this without the 999-call scan.
 *
 * Returns what is fillable; a caller comparing `filled` against the requested
 * amount learns the book is too thin, rather than being told a partial cost as
 * if it were complete.
 */
export function quoteSweep(
  snapshot: BookSnapshot,
  side: number,
  amount: bigint,
  limitTick?: number,
  /**
   * The trader this quote is for.
   *
   * Their own resting orders are skipped, because the matcher skips them: it
   * steps over a self-owned order and keeps matching. Counting that liquidity
   * here would quote a fill the chain will not give — worst when the trader is
   * the one making the market, since their own order is often the best price.
   */
  taker?: string,
): { cost: bigint; filled: bigint; levels: number; avgPrice: number | null } {
  const resting = side === SIDE_BID ? snapshot.asks : snapshot.bids;
  let remaining = amount;
  let cost = 0n;
  let filled = 0n;
  let levels = 0;

  for (const o of resting) {
    if (remaining === 0n) break;
    // Skip, do not stop — the order behind a self-owned one is reachable.
    if (taker !== undefined && o.trader === taker) continue;
    if (limitTick !== undefined) {
      const crosses =
        side === SIDE_BID ? o.priceTick <= limitTick : o.priceTick >= limitTick;
      if (!crosses) break;
    }
    const take = remaining < o.amount ? remaining : o.amount;
    // The taker pays their own leg: p for a bid, (1 - p) for an ask.
    const ticks = side === SIDE_BID ? o.priceTick : NUM_TICKS - o.priceTick;
    cost += (take * BigInt(ticks)) / BigInt(NUM_TICKS);
    filled += take;
    remaining -= take;
    levels += 1;
  }

  return {
    cost,
    filled,
    levels,
    avgPrice: filled > 0n ? Number(cost) / Number(filled) : null,
  };
}
