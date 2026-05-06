import React, { useMemo } from "react";
import {
  useDirectRead,
  readContractSafe,
  useLaunchpadMarketDirect,
} from "../../hooks";
import { useMarketStatsMath } from "../../hooks/useMarketStatsMath";
import { useDeployments } from "../../hooks/useDeployments";
import { useBaseTokenDecimals } from "../../hooks/useBaseTokenDecimals";
import { ERC20_ABI, ABIS } from "../../config/abis";
import { formatUnits } from "@/lib/chain-shim";
import {
  Activity,
  Landmark,
  Scale,
  TrendingUp,
  Package,
  Anchor,
} from "lucide-react";
import { useChainStore } from "../../store/useChainStore";
import { cn } from "../../lib/utils";
import { useTranslation } from "react-i18next";

interface MarketStatsProps {
  marketAddress: `0x${string}`;
}

export const MarketStats: React.FC<MarketStatsProps> = ({ marketAddress }) => {
  const { t } = useTranslation();
  const { selectedChainId } = useChainStore();
  const chainId =
    typeof selectedChainId === "number"
      ? selectedChainId
      : Number(selectedChainId);
  const deployments = useDeployments();
  const ammEngineAddress = deployments?.contracts?.AMMEngine as `0x${string}`;

  // 1. Get Launchpad Data (Seed, Fees, Floor)
  const { launchpad } = useLaunchpadMarketDirect(marketAddress);

  const decimals = useBaseTokenDecimals();

  // 3. Get AMM State (qYes, qNo for Liability) + AMMEngine USDC balance (locked proceeds)
  const usdcAddress = deployments?.contracts?.MockUSDC as `0x${string}`;
  const { data: ammState } = useDirectRead({
    queryKey: [
      "v8",
      "ammState",
      chainId,
      ammEngineAddress,
      marketAddress,
      usdcAddress,
    ],
    enabled:
      !!marketAddress && !!chainId && !!ammEngineAddress && !!usdcAddress,
    chainId,
    read: async (client) => {
      // Need qYes, qNo. Using getMarketState
      const [[qYes, qNo, price], ammEngineUsdcBalance] = await Promise.all([
        readContractSafe<readonly [bigint, bigint, bigint]>(client, {
          address: ammEngineAddress!,
          abi: ABIS.AMMEngine,
          functionName: "getMarketState",
          args: [marketAddress],
        }),
        // Get USDC balance of AMMEngine (total locked proceeds across all users)
        readContractSafe<bigint>(client, {
          address: usdcAddress!,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [ammEngineAddress!],
        }),
      ]);
      return { qYes, qNo, price, lockedProceeds: ammEngineUsdcBalance };
    },
  });

  // 4. Accounting Math
  const stats = useMarketStatsMath(launchpad as any, ammState, decimals);

  if (!stats) return null;

  // Formatting helpers
  const fmtUsd = (val: bigint) => {
    const num = Number(formatUnits(val, decimals));
    if (num > 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
    if (num > 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
    return num.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
  };
  const fmtNum = (val: bigint | number) =>
    Number(typeof val === "bigint" ? formatUnits(val, 18) : val).toLocaleString(
      undefined,
      { maximumFractionDigits: 0 },
    );

  // Projection
  const yesWinLpValue = stats.gross - stats.qYes;
  const noWinLpValue = stats.gross - stats.qNo;

  // Percent calculation using raw WAD values for precision
  const impliedYes = Number(formatUnits(stats.rawQYes, 18));
  const impliedNo = Number(formatUnits(stats.rawQNo, 18));
  const totalShares = impliedYes + impliedNo;
  const yesPct = totalShares > 0 ? (impliedYes / totalShares) * 100 : 50;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-muted" />
          <h2 className="text-lg font-bold text-ink">{t("stats.title")}</h2>
        </div>
        <div className="font-mono text-xs uppercase tracking-[0.12em] text-muted bg-raised px-2 py-1 rounded">
          {t("stats.pureAmmAccounting")}
        </div>
      </div>

      <div className="space-y-4">
        {/* 1. Cash Basis */}
        <div className="p-3">
          <div className="font-mono text-xs text-accent uppercase tracking-[0.12em] mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Landmark size={14} /> {t("stats.cashBasis")}
            </span>
            <span className="text-faint font-mono italic normal-case tracking-normal">
              {t("stats.cashBasisHint")}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-mono text-xs">
              <span className="text-ink" title="Max Loss (b × ln(2))">
                {fmtUsd(stats.maxLoss)}
              </span>
              <span className="text-faint">+</span>
              <span className="text-ink" title="LP Yield Pool">
                {fmtUsd(stats.lpYieldPool)}
              </span>
              <span className="text-faint">+</span>
              <span className="text-ink" title="Swap P&L (LMSR Cost)">
                {stats.pnl >= 0n ? "+" : "-"}
                {fmtUsd(stats.pnl < 0n ? -stats.pnl : stats.pnl)}
              </span>
              <span className="text-faint">=</span>
            </div>
            <div className="text-lg font-bold text-accent font-mono ml-auto">
              {fmtUsd(stats.cash)}
            </div>
          </div>
        </div>

        {/* 2. Equity Floor */}
        <div className="p-3">
          <div className="font-mono text-xs text-accent uppercase tracking-[0.12em] mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Scale size={14} /> {t("stats.equityFloor")}
            </span>
            <span className="text-faint font-mono italic normal-case tracking-normal">
              {t("stats.equityFloorHint")}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-mono text-xs">
              <span className="text-ink">{fmtUsd(stats.cash)}</span>
              <span className="text-faint">−</span>
              <span className="text-ink" title="Max Liability (max(qY, qN))">
                {fmtUsd(stats.liability)}
              </span>
              <span className="text-faint">=</span>
            </div>
            <div className="text-lg font-bold text-accent font-mono ml-auto">
              {fmtUsd(stats.floor)}
            </div>
          </div>
        </div>

        {/* 3. Valuation */}
        <div className="p-3">
          <div className="font-mono text-xs text-accent uppercase tracking-[0.12em] mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <TrendingUp size={14} /> {t("stats.valuation")}
            </span>
            <span className="text-faint font-mono italic normal-case tracking-normal">
              {t("stats.valuationHint")}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-mono text-xs">
              <span className="text-ink">{fmtUsd(stats.floor)}</span>
              <span className="text-faint">/</span>
              <span className="text-ink" title="LP Supply">
                {fmtNum(stats.supply)}
              </span>
              <span className="text-faint">=</span>
            </div>
            <div className="text-lg font-bold text-accent font-mono ml-auto">
              {stats.floorRate.toFixed(3)}x
            </div>
          </div>
        </div>

        {/* 4. TVL */}
        <div className="p-3">
          <div className="font-mono text-xs text-accent uppercase tracking-[0.12em] mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Package size={14} /> {t("stats.tvl")}
            </span>
            <span className="text-faint font-mono italic normal-case tracking-normal">
              {t("stats.tvlHint")}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-mono text-xs">
              <span className="text-ink" title="Cash (MaxLoss + Yield + P&L)">
                {fmtUsd(stats.cash)}
              </span>
              <span className="text-faint">+</span>
              <span className="text-ink" title="Locked (Spendable Proceeds)">
                {fmtUsd(stats.lockedProceeds)}
              </span>
              <span className="text-faint">=</span>
            </div>
            <div className="text-lg font-bold text-accent font-mono ml-auto">
              {fmtUsd(stats.tvl)}
            </div>
          </div>
        </div>

        {/* 5. Liquidity Anchor */}
        <div className="p-3">
          <div className="font-mono text-xs text-accent uppercase tracking-[0.12em] mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Anchor size={14} /> {t("stats.liquidityAnchor")}
            </span>
            <span className="text-faint font-mono italic normal-case tracking-normal">
              {t("stats.liquidityAnchorHint")}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-mono text-xs">
              <span className="text-ink" title="Liquidity Depth (b)">
                {fmtNum(stats.b)}
              </span>
              <span className="text-faint">×</span>
              <span className="text-ink">0.693</span>
              <span className="text-faint">≈</span>
            </div>
            <div className="text-lg font-bold text-accent font-mono ml-auto">
              {fmtNum(stats.supply)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
