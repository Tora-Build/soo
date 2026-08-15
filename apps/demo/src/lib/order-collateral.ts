// What an order costs the trader, and whether they can afford it.
//
// ## Why a sell does not need shares
//
// A YES share and a NO share always sum to $1, so selling YES at p IS buying
// NO at (1 - p), and the order is collateralised by posting (1 - p) in USDC.
// Nothing is delivered and no shares need to exist beforehand — the trader's
// seat carries a negative position, which is the same economic object as
// holding NO. Verified on chain: a wallet holding only USDC placed a sell and
// ended at net -2 shares, having never held a YES or NO token.
//
// So both directions are funded from USDC; only the amount differs. Gating a
// sell on token balance would block a trade the program accepts.

/** Which resource an order consumes. */
export type CollateralKind = "usdc" | "shares";

export interface OrderCollateral {
  kind: CollateralKind;
  /** How much of that resource the order needs. */
  required: number;
  /** How much the trader has. */
  available: number;
  /** Null when the order is affordable. */
  error: string | null;
}

export interface OrderCollateralInput {
  shares: number;
  /** Limit price of the outcome being traded, as a decimal 0..1. */
  price: number;
  isBuying: boolean;
  /** Which outcome the form is quoting — only used for the error message. */
  isYes: boolean;
  /** Trader's USDC, in whole units. */
  availableUsdc: number;
  /** Trader's holding of the quoted outcome token, in whole shares. */
  availableShares: number;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * Decide what an order costs and whether it can be placed.
 *
 * A buy of `n` shares at `p` costs `n × p`. A sell costs `n × (1 - p)` — the
 * complement — because the seller is really buying the opposite outcome at its
 * own price. That is the same arithmetic the program uses to split a fill, so
 * the number shown here is the number that gets escrowed.
 */
export function orderCollateral(input: OrderCollateralInput): OrderCollateral {
  const { shares, price, isBuying, availableUsdc } = input;

  const required = shares * (isBuying ? price : 1 - price);
  return {
    kind: "usdc",
    required,
    available: availableUsdc,
    error:
      shares > 0 && required > availableUsdc
        ? `Insufficient USDC — need $${fmt(required)}, have $${fmt(availableUsdc)}`
        : null,
  };
}
