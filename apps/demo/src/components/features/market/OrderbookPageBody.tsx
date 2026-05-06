/**
 * OrderbookPageBody — the full body of the /orderbook/:addr page,
 * factored out so it can render both as a standalone page (Orderbook.tsx)
 * and inside the wide MarketDrawer launched from the markets listing.
 *
 * Behavior is identical to the previous inline Orderbook.tsx implementation.
 *
 * The optional `onModeChange` prop is forwarded to TradingContextBar so
 * that when this body is rendered inside MarketDrawer, the AMM/Orderbook
 * toggle swaps the drawer's body in place instead of navigating away.
 */
import { useMemo, useState } from "react";
import { keccak256, encodePacked } from "@/lib/chain-shim";

import { TradingContextBar } from "../TradingContextBar";
import { MarketDetailsCard } from "./MarketDetailsCard";
import { useTruthMarketDirect, useLaunchpadMarketDirect } from "../../../hooks";
import { useOnChainMarkets } from "../../../hooks/useOnChainMarkets";
import { SoothBookTerminal, HistoricalPriceCard } from "../pro";
import { useChainStore } from "../../../store/useChainStore";
import { DEFAULT_CHAIN_ID } from "../../../lib/chains";

interface OrderbookPageBodyProps {
  marketAddress: string;
  /** When provided, the AMM/Orderbook toggle in the header will call this
   *  callback instead of navigating via React Router Link. Used by the
   *  wide MarketDrawer to swap modes in place. */
  onModeChange?: (mode: "amm" | "orderbook") => void;
  /** When provided, the trading context bar hides "← Markets" and renders
   *  a close button after the AMM/Orderbook toggle. Used by the modal so
   *  the user can dismiss without backdrop or escape. */
  onClose?: () => void;
}

export const OrderbookPageBody = ({
  marketAddress,
  onModeChange,
  onClose,
}: OrderbookPageBodyProps) => {
  const { selectedChainId } = useChainStore();
  const chainId = Number(selectedChainId) || DEFAULT_CHAIN_ID;
  const { market: truth } = useTruthMarketDirect(
    marketAddress as `0x${string}`,
  );
  const { launchpad } = useLaunchpadMarketDirect(
    marketAddress as `0x${string}`,
  );

  // Read from ALL markets so direct URLs to hidden markets still resolve.
  const { markets: allMarkets } = useOnChainMarkets();
  const sqfMeta = allMarkets.find(
    (m) => m.address.toLowerCase() === marketAddress.toLowerCase(),
  );

  const marketKey = useMemo(() => {
    if (!marketAddress) return undefined;
    return keccak256(
      encodePacked(["address"], [marketAddress as `0x${string}`]),
    );
  }, [marketAddress]);

  // Stage order: finalized > settled > live > expired > bonding.
  // See useOnChainMarkets.ts for the canonical derivation.
  const nowSec = Math.floor(Date.now() / 1000);
  const trialEnded =
    (launchpad?.trialEndTime ?? 0) > 0 &&
    nowSec >= (launchpad?.trialEndTime ?? 0);
  const stage =
    sqfMeta?.stage ??
    (launchpad?.isDismissed
      ? "dismissed"
      : truth?.isFinalized
        ? "finalized"
        : truth?.isSettled
          ? "settled"
          : launchpad?.isGraduated
            ? "live"
            : trialEnded
              ? "expired"
              : "bonding");

  const [viewOutcome, setViewOutcome] = useState<"yes" | "no">("yes");

  const priceCard = (
    <HistoricalPriceCard
      chainId={chainId}
      marketKey={marketKey}
      viewOutcome={viewOutcome}
    />
  );

  return (
    <div className="bg-canvas flex flex-col gap-1">
      <TradingContextBar
        question={
          truth?.question || sqfMeta?.question || sqfMeta?.name || marketAddress
        }
        address={marketAddress}
        stage={stage}
        deadline={truth?.deadline}
        category={sqfMeta?.category}
        event={sqfMeta?.event}
        mode="orderbook"
        showOrderbookSwitch={true}
        onModeChange={onModeChange}
        onClose={onClose}
      />

      <MarketDetailsCard
        address={marketAddress}
        symbol={sqfMeta?.symbol}
        creator={truth?.creator || sqfMeta?.creator}
        adjudicator={truth?.adjudicator}
        deadline={truth?.deadline}
        stage={stage}
        isGraduated={launchpad?.isGraduated}
        isInTrialPeriod={launchpad?.isInTrialPeriod}
        trialTimeRemaining={launchpad?.trialTimeRemaining}
        chainId={chainId}
        rule={sqfMeta?.rule}
      />

      <SoothBookTerminal
        marketAddress={marketAddress as `0x${string}`}
        beforeOrderbookPane={priceCard}
        onOutcomeChange={setViewOutcome}
      />
    </div>
  );
};
