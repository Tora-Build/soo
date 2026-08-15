// The real-market trading surface, routed by venue.
//
// Upstream rendered its CLOB for every activated cell because on the EVM
// deployment an activated market was book-tradeable immediately. Here the
// venues are staged: a market trades on the AMM (in the AMM's token) until it
// graduates, and only then does the book (USDC) open — the program enforces
// it, so a book UI on a bonding cell could only produce rejected orders.
//
// Both panels are the demo's devnet-proven components, not ports: the same
// SimpleTradingPanel that serves /amm/:addr and the same SoothBookTerminal
// that serves /orderbook/:addr.
import { SimpleTradingPanel } from "../../../components/features/SimpleTradingPanel";
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
  return (
    <div className="mx-auto w-full max-w-[560px] p-4">
      <SimpleTradingPanel
        address={cell.marketAddress}
        isGraduated={false}
        isSettled={cell.status === "settled"}
      />
    </div>
  );
}
