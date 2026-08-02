// Pure orderbook helpers, extracted from the hooks so they can be tested.
//
// These were inline in `useOrderbookTrade` and `useIndexerOrders`, which meant
// the tick ladder, the price conversion, the cancel-by-level parser and the
// refund arithmetic had **no unit coverage at all** — the demo's tests cover
// AMM, markets, portfolio and rendering, and everything here was reachable only
// through Surfpool-gated e2e specs.
//
// They are extracted now rather than later because the orderbook redesign
// (`docs/design/orderbook-redesign.md`) changes what a "tick" means: the new
// book quotes a single unified YES axis, so the complement flip below
// disappears. Characterising the current behaviour first is what makes that
// migration checkable instead of hopeful.

/** Ticks per unit price. `NUM_TICKS` in the program. */
export const NUM_TICKS = 1000;
export const MIN_TICK = 1;
export const MAX_TICK = 999;

export function clampUnit(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Convert a resting order's tick to a YES-denominated price.
 *
 * The legacy book is **two-sided**: side 1 (YES) quotes its own price, side 0
 * (NO) quotes the complement, so a NO order at tick 400 is YES at 0.60. Every
 * display surface has to perform that flip, and forgetting it renders the
 * wrong side of the market.
 *
 * The redesigned book removes the flip: it quotes one axis, so `tick / 1000`
 * is the YES price for both sides. When that lands, this function collapses to
 * its `side === 1` branch — and these tests are what will show that the change
 * is a simplification rather than a silent inversion.
 */
export function tickToYesPrice(tick: number, side: 0 | 1): number {
  return side === 1
    ? clampUnit(tick / NUM_TICKS)
    : clampUnit((NUM_TICKS - tick) / NUM_TICKS);
}

/**
 * Collateral returned when a non-escrow order is cancelled, in WAD.
 *
 * This is money rendered to a user, and it hardcodes the 1000-tick
 * denominator: `tick * amount / 1000`. A change to tick granularity silently
 * misreports refunds unless this moves with it.
 *
 * Note it deliberately does NOT apply the complement flip — a resting buy
 * escrows its own tick's worth regardless of side, because side 0 orders are
 * already quoted in their own terms on the legacy book.
 */
export function refundAmountWad(tick: bigint, amountWad: bigint): bigint {
  return (tick * amountWad) / BigInt(NUM_TICKS);
}

export type CancelTarget =
  | { kind: "id"; orderId: bigint }
  | { kind: "level"; side: 0 | 1; tick: number };

/**
 * Resolve a cancel target from an order id.
 *
 * Two shapes reach this. A real on-chain order id is a decimal `u64`. But when
 * the UI only knows a price level — the indexer has not caught up, or the row
 * came from a ladder rather than a specific order — it synthesises
 * `"${side}:${tick}"` and this parses it back out.
 *
 * That round-trip through a string is fragile, and the trailing-digits
 * fallback below is frankly a guess: it scrapes the last 1-3 digits off
 * anything and infers the side from substrings. It is characterised here
 * rather than defended. The redesigned book gives every order a real `seq`
 * from the moment it rests, so the synthesised-id path can be deleted outright
 * rather than ported.
 */
export function parseOrderId(orderId: string): CancelTarget | null {
  const normalized = orderId.trim().toLowerCase();
  if (!normalized) return null;

  if (/^\d+$/.test(normalized)) {
    return { kind: "id", orderId: BigInt(normalized) };
  }

  const directMatch = normalized.match(/^(0|1):(\d{1,3})$/);
  if (directMatch) {
    const side = Number(directMatch[1]) as 0 | 1;
    const tick = Number(directMatch[2]);
    if (tick >= MIN_TICK && tick <= MAX_TICK) return { kind: "level", side, tick };
  }

  const suffixTick = normalized.match(/(\d{1,3})$/);
  if (!suffixTick) return null;

  const tick = Number(suffixTick[1]);
  if (tick < MIN_TICK || tick > MAX_TICK) return null;

  if (normalized.includes("no")) return { kind: "level", side: 0, tick };
  if (normalized.includes("yes") || normalized.includes("bid"))
    return { kind: "level", side: 1, tick };
  if (normalized.includes("ask")) return { kind: "level", side: 0, tick };

  return { kind: "level", side: 1, tick };
}

/** Synthesise the level id that `parseOrderId` reads back. */
export function levelOrderId(side: 0 | 1, tick: number): string {
  return `${side}:${tick}`;
}
