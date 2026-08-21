/**
 * LiquidityDetailPanel — the LP-only stack of cards (graduation progress,
 * holder leaderboard, market stats, redeem CTA) for a single market.
 *
 * Used as the right panel of /liquidity. Self-fetches market data from
 * marketAddress so the parent page only owns selection state.
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useWriteContract } from "@/lib/chain-shim";
import { useQueryClient } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { toast } from "react-hot-toast";

import { Button } from "../../ui/Button";
import { GraduationProgress, LPHolders, MarketStats } from "../index";
import {
  useLaunchpadMarketDirect,
  useTruthMarketDirect,
  useInvalidateQueries,
} from "../../../hooks";
import { useAmmMarketDirect } from "../../../hooks/useAmmMarketDirect";
import { useDeployments } from "../../../hooks/useDeployments";

interface LiquidityDetailPanelProps {
  marketAddress: `0x${string}`;
}

export function LiquidityDetailPanel({
  marketAddress,
}: LiquidityDetailPanelProps) {
  const { t } = useTranslation();
  const { launchpad, isLoading: isLoadingLaunchpad } =
    useLaunchpadMarketDirect(marketAddress);
  const { amm } = useAmmMarketDirect(marketAddress);
  const { market: truth } = useTruthMarketDirect(marketAddress);
  // `finalized` is the post-veto-window settled state — only the truth
  // market exposes it. Required for the redeem CTA gate below.
  const isFinalized = truth?.isFinalized === true;

  const { writeContractAsync, isPending: isWritePending } = useWriteContract();
  const queryClient = useQueryClient();
  const { contracts } = useDeployments();
  const invalidateQueries = useInvalidateQueries();

  const handleRedeemLP = useCallback(async () => {
    if (
      !contracts?.LaunchpadEngine ||
      !writeContractAsync ||
      !launchpad?.userLpBalance
    )
      return;
    try {
      await writeContractAsync({
        address: contracts.LaunchpadEngine as `0x${string}`,
        abi: [
          {
            name: "redeemLp",
            type: "function",
            inputs: [
              { name: "market", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            outputs: [],
            stateMutability: "nonpayable",
          },
        ],
        functionName: "redeemLp",
        args: [marketAddress, launchpad.userLpBalance],
      });
      toast.success(t("liquidityDetail.redeemedSuccess"));
      invalidateQueries();
      queryClient.invalidateQueries({ queryKey: ["v10"] });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t("liquidityDetail.unknownError");
      toast.error(t("liquidityDetail.redeemFailed", { message: msg }));
    }
  }, [
    contracts,
    writeContractAsync,
    launchpad,
    marketAddress,
    invalidateQueries,
    queryClient,
    t,
  ]);

  const showGradProgress =
    !isLoadingLaunchpad &&
    launchpad &&
    !launchpad.isGraduated &&
    !launchpad.isDismissed;

  const showRedeem =
    isFinalized &&
    launchpad?.userLpBalance != null &&
    launchpad.userLpBalance > 0n;

  return (
    <div className="space-y-3">
      {showGradProgress && launchpad && (
        <GraduationProgress
          feesAccrued={launchpad.feesAccrued ?? 0n}
          graduationThreshold={launchpad.graduationThreshold ?? 0n}
          graduationProgress={launchpad.graduationProgress}
          isGraduated={launchpad.isGraduated ?? false}
          canGraduate={launchpad.canGraduate}
          isInTrialPeriod={launchpad.isInTrialPeriod}
          trialTimeRemaining={launchpad.trialTimeRemaining}
          isDismissed={launchpad.isDismissed}
          currentYesPrice={amm?.yesProbability}
        />
      )}

      <div className="bg-raised p-4">
        <LPHolders marketAddress={marketAddress} />
      </div>

      <div className="bg-raised p-4">
        <MarketStats marketAddress={marketAddress} />
      </div>

      {showRedeem && launchpad?.userLpBalance != null && (
        <div className="bg-raised p-4 space-y-3">
          <h4 className="text-sm font-medium text-ink flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-accent" />
            {t("liquidityDetail.lpTokenRedemption")}
          </h4>
          <p className="text-xs text-muted">
            {t("liquidityDetail.redeemPrompt", {
              amount: (Number(launchpad.userLpBalance) / 1e18).toFixed(2),
            })}
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={handleRedeemLP}
            disabled={isWritePending}
          >
            {isWritePending
              ? t("liquidityDetail.redeeming")
              : t("liquidityDetail.redeemLpTokens")}
          </Button>
        </div>
      )}
    </div>
  );
}
