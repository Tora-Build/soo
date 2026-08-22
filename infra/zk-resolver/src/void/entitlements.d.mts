// Types for the entitlement computation. See merkle.d.mts for why these are
// declarations over plain ESM rather than a TypeScript port.

export const WAD_PER_USDC: bigint;

/** One wallet's AMM entitlement. Shares are WAD; the refund is USDC base
 *  units, floored so it can only ever under-refund — the safe direction
 *  against the program's `void_refund_usdc <= locked_cost_usdc` bound. */
export interface AmmEntitlement {
  wallet: string;
  validYesWad: bigint;
  validNoWad: bigint;
  voidedYesWad: bigint;
  voidedNoWad: bigint;
  heldYesWad: bigint;
  heldNoWad: bigint;
  refundWad: bigint;
  refundUsdc: bigint;
}

export interface BookEntitlement {
  wallet: string;
  validNet: bigint;
  refundUsdc: bigint;
}

/** A clamp that bit: the tree was reduced to what the program will accept. */
export interface Anomaly {
  wallet: string;
  reason: string;
  [key: string]: unknown;
}

export interface EntitlementResult<T> {
  entitlements: Map<string, T>;
  anomalies: Anomaly[];
}

/** FIFO: a sale retires the earliest lots first, whenever it happened. */
export function computeAmmEntitlements(args: {
  trades: unknown[];
  tStar: number;
}): EntitlementResult<AmmEntitlement>;

export function computeBookEntitlements(args: {
  legs: unknown[];
  tStar: number;
}): EntitlementResult<BookEntitlement>;

/** Maker floors, taker takes the remainder — mirrors the program's split. */
export function legCosts(
  priceTick: number,
  amount: bigint,
  takerSide: number,
): { makerCost: bigint; takerCost: bigint };

export function orderLeaves(records: unknown[]): unknown[];
