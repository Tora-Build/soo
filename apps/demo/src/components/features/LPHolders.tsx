import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  useLaunchpadMarketDirect,
  useDirectRead,
  readContractSafe,
  useTruthMarketDirect,
} from "../../hooks";
import { useMarketStatsMath } from "../../hooks/useMarketStatsMath";
import { useDeployments } from "../../hooks/useDeployments";
import { useBaseTokenDecimals } from "../../hooks/useBaseTokenDecimals";
import { ERC20_ABI, ABIS } from "../../config/abis";
import { formatUnits } from "@/lib/chain-shim";
import { CircleDollarSign, HelpCircle } from "lucide-react";
import { useChainStore } from "../../store/useChainStore";
import { useAccount } from "@/lib/chain-shim";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/Badge";
import { useTranslation } from "react-i18next";

interface LPHoldersProps {
  marketAddress: `0x${string}`;
}

export const LPHolders: React.FC<LPHoldersProps> = ({ marketAddress }) => {
  const { t } = useTranslation();
  const { selectedChainId } = useChainStore();
  const { address } = useAccount();
  const hintButtonRef = useRef<HTMLButtonElement>(null);
  const chainId =
    typeof selectedChainId === "number"
      ? selectedChainId
      : Number(selectedChainId);
  const deployments = useDeployments();
  const ammEngineAddress = deployments?.contracts?.AMMEngine as `0x${string}`;

  // 1. Get Launchpad Data (includes userLpBalance)
  const { launchpad } = useLaunchpadMarketDirect(marketAddress);

  // 1.5. Fetch creator's actual LP balance
  const launchpadEngineAddress = deployments?.contracts
    ?.LaunchpadEngine as `0x${string}`;
  const { data: creatorLpBalance } = useDirectRead({
    queryKey: [
      "v8",
      "creatorLpBalance",
      chainId,
      launchpad?.lpToken,
      launchpad?.creator,
    ],
    enabled:
      !!marketAddress &&
      !!chainId &&
      !!launchpad?.lpToken &&
      !!launchpad?.creator,
    chainId,
    read: async (client) => {
      const balance = await readContractSafe<bigint>(client, {
        address: launchpad!.lpToken as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [launchpad!.creator as `0x${string}`],
      });
      return balance ?? 0n;
    },
  });

  const decimals = useBaseTokenDecimals();

  // 3. Get AMM State (qYes, qNo for Ceiling Calc)
  const { data: ammState } = useDirectRead({
    queryKey: ["v8", "ammState", chainId, ammEngineAddress, marketAddress],
    enabled: !!marketAddress && !!chainId && !!ammEngineAddress,
    chainId,
    read: async (client) => {
      const [qYes, qNo, price] = await readContractSafe<
        readonly [bigint, bigint, bigint]
      >(client, {
        address: ammEngineAddress!,
        abi: ABIS.AMMEngine,
        functionName: "getMarketState",
        args: [marketAddress],
      });
      return { qYes, qNo, price };
    },
  });

  // 4. Math
  const stats = useMarketStatsMath(launchpad as any, ammState, decimals);

  // 5. Truth Market State (for finalized check)
  const { market: truthMarket } = useTruthMarketDirect(marketAddress);
  const isFinalized = truthMarket?.isFinalized ?? false;

  // Hint state - must be before early return to satisfy Rules of Hooks
  const [showHint, setShowHint] = useState(false);

  if (!launchpad) {
    return null;
  }

  // If stats are missing (e.g. finalized market), only proceed if finalized
  if (!stats && !isFinalized) {
    return null;
  }

  // Safe stats accessors
  const floorRate = stats?.floorRate ?? 0;
  const ceilingRate = stats?.ceilingRate ?? 0;

  const hasUserLp =
    launchpad.userLpBalance !== undefined && launchpad.userLpBalance > 0n;
  const userLP = launchpad.userLpBalance ?? 0n;
  const userLpNum = Number(formatUnits(userLP, 18));
  const userFloorVal = userLpNum * floorRate;
  const userCeilingVal = userLpNum * ceilingRate;

  // Creator LP - use actual fetched balance, not total supply
  const creatorLP = creatorLpBalance ?? 0n;
  const creatorLpNum = Number(formatUnits(creatorLP, 18));
  const creatorFloorVal = creatorLpNum * floorRate;
  const creatorCeilingVal = creatorLpNum * ceilingRate;

  // Total LP for market floor/ceiling display
  const totalLpNum = Number(formatUnits(launchpad.lpSupply, 18));
  const marketFloorVal = totalLpNum * floorRate;
  const marketCeilingVal = totalLpNum * ceilingRate;

  const userSharePct = totalLpNum > 0 ? (userLpNum / totalLpNum) * 100 : 0;
  const creatorSharePct =
    totalLpNum > 0 ? (creatorLpNum / totalLpNum) * 100 : 0;

  // LP Yield Pool (USDC decimals) - only accrues post-graduation
  const lpYieldPool = launchpad.lpYieldPool ?? 0n;
  const lpYieldPoolNum = Number(formatUnits(lpYieldPool, decimals));
  const userYieldShare =
    totalLpNum > 0 ? (userLpNum / totalLpNum) * lpYieldPoolNum : 0;
  const creatorYieldShare =
    totalLpNum > 0 ? (creatorLpNum / totalLpNum) * lpYieldPoolNum : 0;

  // Formatters
  const fmtUsd = (val: number) => {
    if (val > 1_000_000_000) return `$${(val / 1_000_000_000).toFixed(2)}B`;
    if (val > 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
    return val.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
  };
  const fmtLp = (val: number) =>
    val.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });

  const isCreator =
    address && launchpad.creator.toLowerCase() === address.toLowerCase();
  const isGraduated = !!launchpad.isGraduated;
  const hintRect = hintButtonRef.current?.getBoundingClientRect();
  const hintWidth = 288;
  const hintStyle =
    showHint && hintRect
      ? {
          position: "fixed" as const,
          top: Math.min(window.innerHeight - 16, hintRect.bottom + 12),
          left: Math.max(
            16,
            Math.min(
              window.innerWidth - hintWidth - 16,
              hintRect.right - hintWidth,
            ),
          ),
          width: hintWidth,
          zIndex: 9999,
          pointerEvents: "none" as const,
        }
      : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CircleDollarSign className="w-4 h-4 text-accent" />
          <h3 className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
            {t("lp.leaderboard")}
          </h3>
        </div>

        {/* Hint icon */}
        <div className="relative">
          <button
            ref={hintButtonRef}
            onMouseEnter={() => setShowHint(true)}
            onMouseLeave={() => setShowHint(false)}
            onClick={() => setShowHint(!showHint)}
            className="p-1 text-muted hover:text-ink hover:bg-raised/50 transition-colors"
            aria-label={t("uc.lp.showHint")}
          >
            <HelpCircle className="w-3.5 h-3.5" />
          </button>

          {showHint &&
            hintStyle &&
            createPortal(
              <div
                className="p-3 bg-tooltip border border-rule shadow-none"
                style={hintStyle}
              >
                <p className="text-xs text-ink leading-relaxed">
                  {isGraduated
                    ? t("uc.lp.graduatedHint")
                    : t("uc.lp.bondingHint")}
                </p>
              </div>,
              document.body,
            )}
        </div>
      </div>

      {/* The market's own totals, first: a holder's slice means nothing
          without the pie. */}
      <div className="border border-rule bg-inset px-3 py-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
            {t("lp.poolTotal", { defaultValue: "Pool backing" })}
          </div>
          {/* Money first, LP count second. LP is a real token with a real
              supply, but nobody asks "how many LP" — they ask what it is
              worth, and the two numbers were previously so alike (both
              derived from b·ln2) that the units read as interchangeable. */}
          <div className="font-mono text-sm text-ink tabular-nums">
            {stats ? fmtUsd(marketFloorVal) : "—"}
          </div>
          <div className="font-mono text-[10px] text-faint tabular-nums">
            {fmtLp(totalLpNum)} LP total
          </div>
        </div>
        <div className="text-right min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
            {t("lp.redeemRange", { defaultValue: "Redeems between" })}
          </div>
          <div className="font-mono text-sm text-ink tabular-nums">
            {stats ? `${fmtUsd(marketFloorVal)} – ${fmtUsd(marketCeilingVal)}` : "—"}
          </div>
        </div>
      </div>

      {/* Column legend. "Floor / ceiling" is house vocabulary: the pair is a
          RANGE — worst case if the outcome goes against the pool, best case
          if it goes with it — and a reader who has to infer that from two
          bare numbers infers something else. */}
      <div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.12em] text-faint px-1">
        <div>{t("lp.holderShare")}</div>
        <div>
          {t("lp.rangeLegend", { defaultValue: "worst case → best case" })}
        </div>
      </div>

      {/* Creator Row (Always show if it's the primary holder) */}
      <div
        className={cn(
          "bg-raised p-4 border group transition-colors",
          isCreator ? "border-accent" : "border-rule/50 hover:border-accent",
        )}
      >
        <div className="flex justify-between items-start mb-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-ink text-sm">
              {launchpad.creator.slice(0, 6)}...{launchpad.creator.slice(-4)}
            </span>
            <Badge
              className="text-xs h-5 py-0"
              style={{
                backgroundColor: "var(--accent-muted)",
                color: "var(--accent)",
                borderColor: "var(--accent)",
              }}
            >
              {t("lp.creator")}
            </Badge>
            {isCreator && (
              <Badge
                variant="success"
                className="text-xs h-5 py-0"
                style={{
                  backgroundColor: "var(--accent-muted)",
                  color: "var(--accent)",
                  borderColor: "var(--accent)",
                }}
              >
                {t("lp.you")}
              </Badge>
            )}
          </div>
          <div className="text-right">
            <div className="font-mono text-ink font-bold">
              {stats ? (
                fmtUsd(creatorFloorVal)
              ) : (
                <span className="text-muted text-xs">{t("lp.finalized")}</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-between items-center text-xs">
          <div className="flex items-center gap-2 text-muted">
            <span className="text-ink font-bold">
              {creatorSharePct.toFixed(0)}%
            </span>
            <span className="text-faint">•</span>
            <span className="text-faint">{fmtLp(creatorLpNum)} LP</span>
            <span className="text-faint">•</span>
            <span className={creatorYieldShare > 0 ? "text-pos" : "text-faint"}>
              {creatorYieldShare > 0
                ? `+${fmtUsd(creatorYieldShare)} yield`
                : isGraduated
                  ? t("lp.yieldNoneYet", { defaultValue: "no yield yet" })
                  : t("lp.yieldAfterGraduation", {
                      defaultValue: "yield starts at graduation",
                    })}
            </span>
          </div>
          <div className="text-muted font-mono">
            {stats ? fmtUsd(creatorCeilingVal) : "-"}
          </div>
        </div>
      </div>

      {/* User Row (Only if user is NOT the creator but has balance) */}
      {hasUserLp && !isCreator && (
        <div className="bg-raised p-4 border border-accent group transition-colors">
          <div className="flex justify-between items-start mb-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-ink text-sm">
                {address
                  ? `${address.slice(0, 6)}...${address.slice(-4)}`
                  : "Unknown"}
              </span>
              <Badge
                variant="success"
                className="text-xs h-5 py-0"
                style={{
                  backgroundColor: "var(--accent-muted)",
                  color: "var(--accent)",
                  borderColor: "var(--accent)",
                }}
              >
                {t("lp.you")}
              </Badge>
            </div>
            <div className="text-right">
              <div className="font-mono text-ink font-bold">
                {stats ? (
                  fmtUsd(userFloorVal)
                ) : (
                  <span className="text-muted text-xs">
                    {t("lp.finalized")}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-between items-center text-xs">
            <div className="flex items-center gap-2 text-muted">
              <span className="text-ink font-bold">
                {userSharePct.toFixed(0)}%
              </span>
              <span className="text-faint">•</span>
              <span className="text-faint">{fmtLp(userLpNum)} LP</span>
              {userYieldShare > 0 && (
                <>
                  <span className="text-faint">•</span>
                  <span className="text-muted">
                    +{fmtUsd(userYieldShare)} yield
                  </span>
                </>
              )}
            </div>
            <div className="text-muted font-mono">
              {stats ? fmtUsd(userCeilingVal) : "-"}
            </div>
          </div>
        </div>
      )}

      {/* LP Yield Pool */}
      <div className="bg-raised p-4">
        <div className="flex justify-between items-center mb-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
              {t("lp.yieldPool")}
            </span>
            {!isGraduated && (
              <span className="text-xs text-muted bg-raised/50 px-1.5 py-0.5 rounded">
                {t("lp.accruersPostGrad")}
              </span>
            )}
          </div>
          <span
            className={cn(
              "text-lg font-bold font-mono",
              lpYieldPoolNum > 0 ? "text-ink" : "text-faint",
            )}
          >
            {fmtUsd(lpYieldPoolNum)}
          </span>
        </div>

        {/* User's yield share */}
        {(hasUserLp || isCreator) && lpYieldPoolNum > 0 && (
          <div className="flex justify-between items-center text-xs pt-2 border-t border-rule/20">
            <span className="text-muted">
              {t("lp.yourShare")} (
              {(isCreator ? creatorSharePct : userSharePct).toFixed(1)}%)
            </span>
            <span className="text-muted font-mono font-bold">
              {fmtUsd(isCreator ? creatorYieldShare : userYieldShare)}
            </span>
          </div>
        )}

        {lpYieldPoolNum === 0 && (
          <div className="text-xs text-muted italic">
            {isGraduated ? t("lp.noYieldYet") : t("lp.yieldEmptyBonding")}
          </div>
        )}
      </div>

      {/* Stats Summary - Shows TOTAL market values with exchange rates */}
      <div className="bg-raised p-4">
        <div className="grid grid-cols-2 gap-4 mb-4">
          {/* Floor */}
          <div>
            <div className="font-mono text-xs text-muted uppercase tracking-[0.12em] mb-1">
              {t("lp.floor")}
            </div>
            <div className="text-2xl font-bold text-ink tracking-tight">
              {stats ? (
                fmtUsd(marketFloorVal)
              ) : (
                <span className="text-lg">{t("lp.finalized")}</span>
              )}
            </div>
            <div className="text-sm font-mono text-muted">
              {stats ? `${stats.floorRate.toFixed(3)}x` : "-"}
            </div>
          </div>
          {/* Ceiling */}
          <div className="text-right">
            <div className="font-mono text-xs text-muted uppercase tracking-[0.12em] mb-1">
              {t("lp.ceiling")}
            </div>
            <div className="text-2xl font-bold text-ink tracking-tight">
              {stats ? (
                fmtUsd(marketCeilingVal)
              ) : (
                <span className="text-lg">-</span>
              )}
            </div>
            <div className="text-sm font-mono text-muted">
              {stats ? `${stats.ceilingRate.toFixed(3)}x` : "-"}
            </div>
          </div>
        </div>

        <div className="flex justify-between items-center pt-3 border-t border-rule/50 text-xs font-mono">
          <span className="text-muted">
            {t("lp.total")} {fmtLp(totalLpNum)} LP
          </span>
          <span className="text-ink">{t("lp.totalAccounted")}</span>
        </div>
      </div>
    </div>
  );
};
