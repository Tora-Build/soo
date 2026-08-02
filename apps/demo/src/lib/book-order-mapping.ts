// Map the demo's order form onto a `book_place` call.
//
// This is the risky part of switching the write path, so it lives here as a
// pure function with tests rather than inline in a 900-line hook.
//
// ## Three encodings meet here
//
// 1. **The form** speaks (outcome, price, isBuy) where price is the price of
//    the thing named by `outcome`.
// 2. **`useOrderbookTrade` uses INVERTED outcome encoding** — `outcome === 0`
//    means YES and `outcome === 1` means NO, the opposite of the protocol's
//    canonical `0 = NO, 1 = YES`. That inversion is load-bearing at the call
//    site (`SoothBookTerminal.tsx`), so it is honoured here rather than
//    "corrected" halfway up the stack, which would silently flip every order.
// 3. **The book** has one axis: a `SIDE_BID` buys YES at tick `t`, a `SIDE_ASK`
//    sells YES at tick `t` — equivalently buys NO at `1 - t`.
//
// ## The four quadrants
//
// | form                | book                          |
// |---------------------|-------------------------------|
// | buy YES at p        | BID at p                      |
// | sell YES at p       | ASK at p                      |
// | buy NO at q         | ASK at 1 - q                  |
// | sell NO at q        | BID at 1 - q                  |
//
// Buying NO is selling YES. That identity is the whole reason the redesigned
// book needs one axis instead of two, and it is where the legacy path spent a
// `buyNo`-at-`oppositeTick` special case per direction.

export const SIDE_BID = 0;
export const SIDE_ASK = 1;
export const NUM_TICKS = 1000;
export const MIN_TICK = 1;
export const MAX_TICK = 999;

/** WAD (1e18) → USDC base units (1e6), the unit the book counts in. */
export const WAD_TO_BASE = 1_000_000_000_000n;

export interface BookPlaceArgs {
  side: number;
  limitTick: number;
  /** USDC base units. */
  amount: bigint;
  matchLimit: number;
  postRemainder: boolean;
}

export class OrderMappingError extends Error {}

/**
 * Clamp a decimal price to a tradeable tick.
 *
 * 0 is free and 1000 is certain, so neither can rest — the program rejects
 * both. Clamping rather than throwing matches the legacy `clampTick`, so a
 * slider at either extreme still produces an order instead of an error toast.
 */
export function priceToTick(price: number): number {
  if (!Number.isFinite(price)) {
    throw new OrderMappingError(`price must be finite, got ${price}`);
  }
  return Math.min(MAX_TICK, Math.max(MIN_TICK, Math.round(price * NUM_TICKS)));
}

/**
 * Convert WAD shares to the book's base units.
 *
 * Floors. A sub-base-unit order would round to zero size, so that is rejected
 * rather than submitted as a no-op transaction the user pays for.
 */
export function sharesWadToBase(sharesWad: bigint): bigint {
  const base = sharesWad / WAD_TO_BASE;
  if (base <= 0n) {
    throw new OrderMappingError(
      "order is smaller than one base unit — it would round to zero size",
    );
  }
  return base;
}

/**
 * Build `book_place` arguments from the form's inputs.
 *
 * `outcome` uses the hook's INVERTED encoding: 0 = YES, 1 = NO.
 */
export function toBookPlace(opts: {
  outcome: 0 | 1;
  /** Price of the outcome named above, as a decimal 0..1. */
  price: number;
  sharesWad: bigint;
  isBuy: boolean;
  matchLimit?: number;
  postRemainder?: boolean;
}): BookPlaceArgs {
  const { outcome, price, sharesWad, isBuy } = opts;
  const isYes = outcome === 0; // inverted encoding — see the module docs

  // Everything is quoted on the YES axis, so a NO price becomes its
  // complement. Doing this in tick space rather than on the decimal avoids a
  // second rounding step disagreeing with the first.
  const ownTick = priceToTick(price);
  const yesTick = isYes ? ownTick : NUM_TICKS - ownTick;

  // Buying YES and selling NO both take the bid; selling YES and buying NO
  // both take the ask.
  const side = isYes === isBuy ? SIDE_BID : SIDE_ASK;

  const limitTick = Math.min(MAX_TICK, Math.max(MIN_TICK, yesTick));

  return {
    side,
    limitTick,
    amount: sharesWadToBase(sharesWad),
    matchLimit: opts.matchLimit ?? 8,
    postRemainder: opts.postRemainder ?? true,
  };
}
