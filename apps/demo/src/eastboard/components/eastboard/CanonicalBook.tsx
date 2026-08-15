// The real-market trading surface, routed by venue.
//
// Venues are staged: a market trades on the AMM (in the AMM's token) until it
// graduates, and only then does the book (USDC) open — the program enforces
// it, so a book UI on a bonding cell could only produce rejected orders.
//
// The graduated panel is the same SoothBookTerminal that serves
// /orderbook/:addr.
import { BondingTrade } from "./BondingTrade";
import { SoothBookTerminal } from "../../../components/features/pro/SoothBookTerminal";
import type { OptionChainCell } from "../../hooks/useOptionChain";

export function CanonicalBook({
  cell,
}: {
  cell: OptionChainCell;
  initialAction?: "buyYes" | "sellYes";
}) {
  if (!cell.marketAddress) return null;
  // "live" is deriveCellStatus's graduated-and-open; everything else with a
  // market — activating (bonding), closed, settled — belongs to the AMM
  // panel, which also carries the settled-claim flow.
  if (cell.status === "live") {
    return (
      <div className="p-4">
        <SoothBookTerminal
          marketAddress={cell.marketAddress}
          marketQuestion={cell.template.question}
        />
      </div>
    );
  }
  // Pre-graduation: the drawer's OWN simplified panel, not the classic demo
  // panel.
  return <BondingTrade cell={cell} />;
}
