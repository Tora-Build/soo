/**
 * AMMPageBody — the full body of the /amm/:addr page, factored out so it
 * can be rendered both as a standalone page (apps/demo/src/pages/AMM.tsx)
 * and inside the wide MarketDrawer launched from the markets listing.
 *
 * Behavior is identical to the previous inline AMM.tsx implementation —
 * this is a pure refactor. All hooks, layout, and conditional rendering
 * are preserved.
 *
 * The optional `onModeChange` prop is forwarded to TradingContextBar so
 * that when this body is rendered inside MarketDrawer, the AMM/Orderbook
 * toggle swaps the drawer's body in place instead of navigating away.
 * Standalone page mode (no callback) keeps the original Link navigation.
 */
import { lookupMarketQuestion } from "../../../lib/market-questions";
import { useCallback } from "react";
import { BarChart3 } from "lucide-react";
import { useWriteContract } from "@/lib/chain-shim";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "react-hot-toast";

import { useChainStore } from "../../../store/useChainStore";
import { Button } from "../../ui/Button";
import { GraduationProgress, AMMSettlementCard } from "..";
import { SimpleTradingPanel } from "../SimpleTradingPanel";
import { MarketDetailsCard } from "./MarketDetailsCard";
import { TradingContextBar } from "../TradingContextBar";
import { EventChartCard } from "./EventChartCard";
import {
  useTruthMarketDirect,
  useLaunchpadMarketDirect,
  useVisibleMarkets,
  useInvalidateQueries,
} from "../../../hooks";
import { useAmmMarketDirect } from "../../../hooks/useAmmMarketDirect";
import { useOnChainMarkets } from "../../../hooks/useOnChainMarkets";
import { useDeployments } from "../../../hooks/useDeployments";

interface AMMPageBodyProps {
  marketAddress: string;
  /** When provided, the AMM/Orderbook toggle in the header will call this
   *  callback instead of navigating via React Router Link. Used by the
   *  wide MarketDrawer to swap modes in place. */
  onModeChange?: (mode: "amm" | "orderbook") => void;
  /** When provided, the trading context bar hides "← Markets" and renders
   *  a close button after the AMM/Orderbook toggle. Used by the modal so
   *  the user can dismiss without backdrop or escape. */
  onClose?: () => void;
  /** When provided, clicking a sibling outcome in the event chart calls
   *  this callback instead of navigating. Used by the QuickTrade modal
   *  to swap the loaded market in place. */
  onSelectMarket?: (address: string) => void;
}

export const AMMPageBody = ({
  marketAddress,
  onModeChange,
  onClose,
  onSelectMarket,
}: AMMPageBodyProps) => {
  const { t } = useTranslation();
  const { selectedChainId } = useChainStore();
  const chainId =
    typeof selectedChainId === "number"
      ? selectedChainId
      : Number(selectedChainId);

  // Market data hooks
  const { market: truth } = useTruthMarketDirect(
    marketAddress as `0x${string}`,
  );
  const { launchpad, isLoading: isLoadingLaunchpad } = useLaunchpadMarketDirect(
    marketAddress as `0x${string}`,
  );
  const { amm } = useAmmMarketDirect(marketAddress as `0x${string}`);

  // SQF metadata: read from ALL markets (unfiltered) so direct URLs to
  // hidden markets still resolve. Visibility filter is for listings only.
  const { markets: allMarkets } = useOnChainMarkets();
  const { markets: visibleMarkets } = useVisibleMarkets();
  const sqfMeta = allMarkets.find(
    (m) => m.address.toLowerCase() === marketAddress.toLowerCase(),
  );

  // Contract interaction
  const { writeContractAsync, isPending: isWritePending } = useWriteContract();
  const queryClient = useQueryClient();
  const { contracts } = useDeployments();
  const invalidateQueries = useInvalidateQueries();

  const handleRedeemLP = useCallback(
    async (marketAddr: string, lpBalance: bigint) => {
      if (!contracts?.LaunchpadEngine || !writeContractAsync) return;
      try {
        await writeContractAsync({
          address: contracts.LaunchpadEngine as `0x${string}`,
          abi: [
            {
              name: "redeemLP",
              type: "function",
              inputs: [
                { name: "market", type: "address" },
                { name: "amount", type: "uint256" },
              ],
              outputs: [],
              stateMutability: "nonpayable",
            },
          ],
          functionName: "redeemLP",
          args: [marketAddr as `0x${string}`, lpBalance],
        });
        toast.success(t("liquidityDetail.redeemedSuccess"));
        invalidateQueries();
        queryClient.invalidateQueries({ queryKey: ["v10"] });
      } catch (e: unknown) {
        const msg =
          e instanceof Error ? e.message : t("liquidityDetail.unknownError");
        toast.error(t("liquidityDetail.redeemFailed", { message: msg }));
      }
    },
    [contracts, writeContractAsync, invalidateQueries, queryClient, t],
  );

  // Stage order: finalized > settled > live > expired > bonding.
  // "expired" = trial period ended without graduation. Pure UI derivation
  // from contract's per-market trialEndTimes + graduation flag.
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

  const chartCard = (() => {
    const siblings = sqfMeta?.event
      ? visibleMarkets.filter(
          (m) =>
            m.event?.toLowerCase() === sqfMeta.event?.toLowerCase() &&
            m.creator?.toLowerCase() === sqfMeta.creator?.toLowerCase(),
        )
      : [];
    const chartMarkets =
      siblings.length >= 2
        ? siblings.map((m) => ({
            address: m.address,
            question: m.question,
            category: m.category,
            deadline: m.deadline,
            bCurrent: m.bCurrent,
            creator: m.creator,
          }))
        : [
            {
              address: marketAddress,
              question: sqfMeta?.question || sqfMeta?.name || marketAddress,
              category: sqfMeta?.category,
              deadline: sqfMeta?.deadline,
              bCurrent: sqfMeta?.bCurrent,
              creator: sqfMeta?.creator,
            },
          ];
    return (
      <EventChartCard
        event={sqfMeta?.event ?? ""}
        category={sqfMeta?.category}
        chainId={chainId}
        currentAddress={marketAddress}
        basePath="/amm"
        markets={chartMarkets}
        onMarketClick={onSelectMarket}
      />
    );
  })();

  return (
    <div className="bg-canvas flex flex-col gap-1">
      {/* Context Bar */}
      <TradingContextBar
        question={
          // `truth.question` is the on-chain hash, not text, and sqfMeta is
          // empty for markets without off-chain metadata — so both fall
          // through and the title used to be the raw address. The local cache
          // holds what `MarketCreated` emitted, which is the actual question.
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
        mode="amm"
        showOrderbookSwitch={Boolean(
          launchpad?.isGraduated && !launchpad?.isDismissed,
        )}
        onModeChange={onModeChange}
        onClose={onClose}
      />

      {/* Full-width market details under the title bar */}
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

      {/* Main Content Grid — chart on left, trading on right */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-1 bg-canvas">
        {/* Left Column: Bonding curve progress (if applicable) + price chart + education link */}
        <div className="flex flex-col gap-1">
          {stage === "bonding" && (
            <GraduationProgress
              feesAccrued={launchpad?.feesAccrued ?? 0n}
              graduationThreshold={launchpad?.graduationThreshold ?? 0n}
              graduationProgress={launchpad?.graduationProgress}
              isGraduated={launchpad?.isGraduated ?? false}
              canGraduate={launchpad?.canGraduate ?? false}
              isInTrialPeriod={launchpad?.isInTrialPeriod ?? false}
              trialTimeRemaining={launchpad?.trialTimeRemaining ?? 0}
              isDismissed={launchpad?.isDismissed ?? false}
              currentYesPrice={amm?.yesProbability}
            />
          )}
          {chartCard}
        </div>

        {/* Right Column: Trading panel */}
        <div className="flex flex-col gap-1">
          <div className="bg-raised">
            {truth?.isSettled === true ||
            truth?.isFinalized === true ||
            stage === "settled" ||
            stage === "finalized" ? (
              <>
                <AMMSettlementCard
                  address={marketAddress as `0x${string}`}
                  stage={stage}
                />

                {stage === "finalized" &&
                  launchpad?.userLpBalance &&
                  launchpad.userLpBalance > 0n && (
                    <div className="p-4 space-y-3">
                      <h4 className="text-sm font-medium text-ink flex items-center gap-2">
                        <BarChart3 className="w-4 h-4 text-accent" />
                        {t("liquidityDetail.lpTokenRedemption")}
                      </h4>
                      <p className="text-xs text-muted">
                        {t("liquidityDetail.redeemPrompt", {
                          amount: (
                            Number(launchpad.userLpBalance) / 1e18
                          ).toFixed(2),
                        })}
                      </p>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="w-full"
                        onClick={() =>
                          handleRedeemLP(marketAddress, launchpad.userLpBalance)
                        }
                        disabled={isWritePending}
                      >
                        {isWritePending
                          ? t("liquidityDetail.redeeming")
                          : t("liquidityDetail.redeemLpTokens")}
                      </Button>
                    </div>
                  )}
              </>
            ) : (
              <SimpleTradingPanel
                address={marketAddress as `0x${string}`}
                isGraduated={launchpad?.isGraduated}
                isSettled={Boolean(truth?.isSettled)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
