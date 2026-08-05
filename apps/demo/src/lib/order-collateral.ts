// What an order costs the trader, and whether they can afford it.
//
// ## Why a sell no longer needs shares
//
// On the EVM book, selling YES means delivering YES shares: the order is
// collateralised by the tokens themselves, so you must hold them first — which
// in turn means minting a YES+NO pair for $1 and selling off the leg you do
// not want. The demo carried that rule over as a hard gate:
//
//   "Sell burns shares (escrow). Short selling without shares is not supported
//    by the demo flow today — block any sell where requested > held."
//
// The redesigned book does not work that way. A YES share and a NO share
// always sum to $1, so selling YES at p IS buying NO at (1 - p), and the order
// is collateralised by posting (1 - p) in USDC. Nothing is delivered and no
// shares need to exist beforehand — the trader's seat simply carries a
// negative position, which is the same economic object as holding NO.
//
// Verified on chain: a wallet holding only USDC placed a sell and ended at
// net -2 shares, having never held a YES or NO token.
//
// So the gate was blocking a trade the program accepts. Both directions are
// funded from USDC now; only the amount differs.

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
  /**
   * True once the redesigned book is the write path. On the legacy book a sell
   * still delivers tokens, so the old gate is still correct there.
   */
  redesignedBook: boolean;
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
  const { shares, price, isBuying, isYes, availableUsdc, availableShares } =
    input;

  // A sell on the legacy book is settled in tokens, so it is gated on tokens.
  if (!isBuying && !input.redesignedBook) {
    return {
      kind: "shares",
      required: shares,
      available: availableShares,
      error:
        shares > 0 && shares > availableShares
          ? `Insufficient ${isYes ? "YES" : "NO"} — need ${fmt(shares)}, have ${fmt(availableShares)}`
          : null,
    };
  }

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
