/**
 * Lifecycle state of an option-chain cell.
 *
 * A market's life does not go straight from tradeable to settled: trading
 * freezes at the exchange close, then resolution and a guardian veto window
 * pass before settlement. Showing "Trade" through that gap invites orders the
 * book rejects, and hiding the claimable step strands holders' payouts.
 */
export type OptionCellStatus =
  | "available"
  | "activating"
  | "closed"
  | "live"
  | "settled";

export interface CellStatusInput {
  hasMarket: boolean;
  isGraduated: boolean;
  isSettled: boolean;
  closeTsSeconds: number;
  nowSeconds: number;
}

export function deriveCellStatus(input: CellStatusInput): OptionCellStatus {
  if (input.isSettled) return "settled";
  if (!input.hasMarket) return "available";
  // Past its close: trading is frozen while resolution and the veto window
  // run, REGARDLESS of graduation — this check used to sit below the
  // graduation branch, so a bonding market past close read "activating" and
  // routed to a trade form whose every submission the program rejects.
  if (input.nowSeconds >= input.closeTsSeconds) return "closed";
  if (!input.isGraduated) return "activating";
  return "live";
}
