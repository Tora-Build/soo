const TICKS_PER_DOLLAR = 1_000;
const TICKS_PER_CENT = 10;
const WAD_PER_TENTH_CENT = 10n ** 15n;

/** Display a binary-contract price in cents at the board's quote precision. */
export function formatCents(cents: number, fractionDigits = 1): string {
  if (!Number.isFinite(cents)) return "—";
  return `${cents.toFixed(fractionDigits)}¢`;
}

/** Convert a 0..1 WAD contract price to a one-decimal cent label. */
export function formatWadPriceCents(priceWad: bigint): string {
  const tenths = (priceWad + WAD_PER_TENTH_CENT / 2n) / WAD_PER_TENTH_CENT;
  return `${tenths / 10n}.${tenths % 10n}¢`;
}

export function centsToOrderTick(cents: number): number {
  if (!Number.isInteger(cents) || cents < 1 || cents > 99) {
    throw new Error("order price must be a whole cent from 1 to 99");
  }
  return cents * TICKS_PER_CENT;
}

export function orderTickCentsLabel(tick: number): string {
  return (tick / TICKS_PER_CENT).toFixed(1);
}

export function yesPriceCentsLabel(side: number, tick: number): string {
  const yesTick = side === 1 ? tick : TICKS_PER_DOLLAR - tick;
  return orderTickCentsLabel(yesTick);
}

const WAD = 10n ** 18n;

export function complementWadPriceCents(priceWad: bigint): string {
  return formatWadPriceCents(WAD - priceWad);
}

export function complementPriceCents(yesCents: number): number {
  if (!Number.isInteger(yesCents) || yesCents < 1 || yesCents > 99) {
    throw new Error("price must be a whole cent from 1 to 99");
  }
  return 100 - yesCents;
}

export function complementTick(tick: number): number {
  if (!Number.isInteger(tick) || tick < 1 || tick > 999) {
    throw new Error("tick must be an integer from 1 to 999");
  }
  return TICKS_PER_DOLLAR - tick;
}

/** Collateral a resting order escrows: shares x price, ceil to the token unit. */
export function orderCollateralRaw(
  shares: number,
  cents: number,
  decimals: number,
): bigint {
  const sharesRaw = BigInt(Math.round(shares * 10 ** decimals));
  return (sharesRaw * BigInt(cents) + 99n) / 100n;
}

/**
 * Worst-case spend for an order: collateral plus the market's trade fee, which
 * the book charges when the order crosses and fills as a taker. Approving only
 * the collateral reverts a crossing order with ERC20InsufficientAllowance, so
 * both the approval and the quoted max cost must include the fee.
 */
export function orderMaxCostRaw(
  shares: number,
  cents: number,
  decimals: number,
  feeBps: bigint,
): bigint {
  const collateral = orderCollateralRaw(shares, cents, decimals);
  const fee = (collateral * feeBps + 9_999n) / 10_000n;
  return collateral + fee;
}

export interface OrderEconomics {
  collateralRaw: bigint;
  feeRaw: bigint;
  maxDebitRaw: bigint;
  payoutIfRightRaw: bigint;
  profitIfRightRaw: bigint;
  invalidPayoutRaw: bigint;
  invalidProfitRaw: bigint;
}

/**
 * Worst-case pre-signing economics for a crossing binary order.
 *
 * One winning share redeems for 100 cents of collateral, a losing share for 0,
 * and INVALID redeems either side for 50 cents. The fee is included because a
 * crossing order pays it on top of collateral; a resting order may lock less
 * until it fills, but this is the maximum debit the wallet must be ready to
 * fund.
 */
export function orderEconomicsRaw(
  shares: number,
  cents: number,
  decimals: number,
  feeBps: bigint,
): OrderEconomics {
  const collateralRaw = orderCollateralRaw(shares, cents, decimals);
  const maxDebitRaw = orderMaxCostRaw(shares, cents, decimals, feeBps);
  const feeRaw = maxDebitRaw - collateralRaw;
  const payoutIfRightRaw = BigInt(Math.round(shares * 10 ** decimals));
  const invalidPayoutRaw = payoutIfRightRaw / 2n;
  return {
    collateralRaw,
    feeRaw,
    maxDebitRaw,
    payoutIfRightRaw,
    profitIfRightRaw: payoutIfRightRaw - maxDebitRaw,
    invalidPayoutRaw,
    invalidProfitRaw: invalidPayoutRaw - maxDebitRaw,
  };
}
