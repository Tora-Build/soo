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
import { lookupMarketQuestion } from "../../../lib/market-questions";
import { useContext, useMemo, useState } from "react";
import { keccak256, encodePacked } from "@/lib/chain-shim";

import { TradingContextBar } from "../TradingContextBar";
import { MarketDetailsCard } from "./MarketDetailsCard";
import { useTruthMarketDirect, useLaunchpadMarketDirect } from "../../../hooks";
import { useOnChainMarkets } from "../../../hooks/useOnChainMarkets";
import { SoothBookTerminal, HistoricalPriceCard } from "../pro";
import { useChainStore } from "../../../store/useChainStore";
import { DEFAULT_CHAIN_ID } from "../../../lib/chains";
import { ErrorBoundary } from "../../ui/ErrorBoundary";
import { DemoContextObj } from "../../../lib/DemoContext";

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
  const demoCtx = useContext(DemoContextObj);
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
  const pageMarketRef = useMemo(() => {
    if (!marketAddress) return null;
    if (marketAddress.startsWith("sol:")) return marketAddress;
    if (marketAddress.startsWith("0x")) return `sol:${marketAddress.slice(2)}`;
    return `sol:${marketAddress}`;
  }, [marketAddress]);

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
          // `truth.question` is the on-chain hash, not text, and sqfMeta is
          // empty for markets without off-chain metadata — so both can fall
          // through. The local cache holds what `MarketCreated` emitted,
          // which is the actual question; the raw address is the last resort.
          truth?.question ||
          sqfMeta?.question ||
          sqfMeta?.name ||
          lookupMarketQuestion(marketAddress) ||
          marketAddress
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
        currentFeeBps={launchpad?.currentFeeBps}
        isInTrialPeriod={launchpad?.isInTrialPeriod}
        trialTimeRemaining={launchpad?.trialTimeRemaining}
        chainId={chainId}
        rule={sqfMeta?.rule}
      />

      <ErrorBoundary
        context="Orderbook Terminal"
        fallback={
          <div className="bg-raised p-10 text-center space-y-3">
            <h2 className="font-sans text-lg font-medium text-ink">
              Orderbook unavailable
            </h2>
            <p className="text-sm text-muted max-w-md mx-auto">
              The orderbook terminal failed to load. This is a render error, not
              a missing program — the book lives in{" "}
              <span className="font-mono">sooth_core</span> and is deployed.
              Check the browser console for the cause.
            </p>
            <a
              href={`/amm/${marketAddress}`}
              className="inline-block mt-2 px-4 py-2 font-mono text-xs uppercase tracking-[0.12em] font-bold border border-accent text-accent hover:bg-accent-muted"
            >
              Go to AMM
            </a>
          </div>
        }
      >
        <DemoContextObj.Provider
          value={
            demoCtx && pageMarketRef
              ? { ...demoCtx, marketRef: pageMarketRef }
              : demoCtx
          }
        >
          <SoothBookTerminal
            marketAddress={marketAddress as `0x${string}`}
            beforeOrderbookPane={priceCard}
            onOutcomeChange={setViewOutcome}
          />
        </DemoContextObj.Provider>
      </ErrorBoundary>
    </div>
  );
};
