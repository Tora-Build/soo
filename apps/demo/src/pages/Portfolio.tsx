import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useAccount } from "@/lib/chain-shim";
import { formatUnits } from "@/lib/chain-shim";
import { ArrowRight } from "lucide-react";
import { Card } from "../components/ui/Card";
import { useActivePositions, useLPPositions } from "../hooks";
import { TradingAccountCard } from "../components/features/portfolio/TradingAccountCard";
import { ActiveOrdersCard } from "../components/features/portfolio/ActiveOrdersCard";
import { formatCurrencyCompact } from "../lib/utils";
import { useTranslation } from "react-i18next";

const formatUsd = (value: number) => formatCurrencyCompact(value);

const formatBigint = (value: bigint, decimals: number, digits = 4) => {
  return Number(formatUnits(value, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
};

export const Portfolio = () => {
  const { t } = useTranslation();
  const { isConnected } = useAccount();
  const {
    vaultPositions: activePositions = [],
    totalPositionValue = 0,
    isLoading: loadingPositions,
  } = useActivePositions();
  const {
    positions: lpPositions = [],
    totalLPValue = 0n,
    isLoading: loadingLp,
  } = useLPPositions();

  const totalLPValueNumber = useMemo(
    () => Number(formatUnits(totalLPValue, 6)),
    [totalLPValue],
  );
  const totalPortfolioValue = totalPositionValue + totalLPValueNumber;

  if (!isConnected) {
    return (
      <div className="text-center py-20">
        <p className="text-ink font-bold mb-2">{t("common.connectWallet")}</p>
        <p className="text-muted text-sm">
          {t("portfolio.connectDescription")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="bg-raised border border-rule p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-bold text-ink text-balance">
              {t("portfolio.title")}
            </h2>
            <p className="text-sm text-muted mt-1 text-pretty">
              {t("portfolio.subtitle")}
            </p>
          </div>
          <div className="text-left sm:text-right">
            <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
              {t("portfolio.totalValue")}
            </p>
            <p className="text-2xl font-mono font-semibold text-ink">
              {formatUsd(totalPortfolioValue)}
            </p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="border border-rule bg-inset p-4">
            <p className="text-xs text-muted">
              {t("portfolio.activePositionValue")}
            </p>
            <p className="mt-1 text-base font-mono font-semibold text-ink">
              {formatUsd(totalPositionValue)}
            </p>
          </div>
          <div className="border border-rule bg-inset p-4">
            <p className="text-xs text-muted">
              {t("portfolio.lpFloorValue")}
            </p>
            <p className="mt-1 text-base font-mono font-semibold text-ink">
              {formatUsd(totalLPValueNumber)}
            </p>
          </div>
          <div className="border border-rule bg-inset p-4">
            <p className="text-xs text-muted">
              {t("portfolio.openMarkets")}
            </p>
            <p className="mt-1 text-base font-mono font-semibold text-ink">
              {activePositions.length + lpPositions.length}
            </p>
          </div>
        </div>
      </Card>

      <TradingAccountCard />

      <Card className="bg-raised border border-rule p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-ink">
            {t("portfolio.activePositions")}
          </h3>
          <span className="text-xs font-mono text-muted">
            {loadingPositions
              ? t("common.loading")
              : `${activePositions.length} ${t("portfolio.markets")}`}
          </span>
        </div>

        {loadingPositions ? (
          <div className="border border-rule bg-inset p-4 text-sm text-muted">
            {t("portfolio.loadingPositions")}
          </div>
        ) : activePositions.length === 0 ? (
          <div className="border border-rule bg-inset p-6 text-center space-y-3">
            <p className="text-sm text-muted">
              {t("portfolio.noPositions")}
            </p>
            <Link
              to="/markets"
              className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-accent hover:underline"
            >
              Browse markets to start trading
              <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {activePositions.map((position) => {
              const totalShares = position.walletYes + position.walletNo;
              return (
                <div
                  key={position.id}
                  className="border border-rule bg-inset p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink text-pretty">
                        {position.question}
                      </p>
                      <p className="text-xs text-muted mt-1">
                        {position.isSettled ? "Resolved" : t("common.live")}{" "}
                        market
                      </p>
                    </div>
                    <div className="text-left sm:text-right">
                      <p className="text-xs text-muted">
                        {t("portfolio.estimatedValue")}
                      </p>
                      <p className="text-sm font-mono font-semibold text-ink">
                        {formatUsd(position.value)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                    <div className="border border-rule bg-raised p-3">
                      <p className="text-xs text-muted">
                        {t("portfolio.yesShares")}
                      </p>
                      <p className="mt-1 font-mono text-ink">
                        {position.walletYes.toFixed(4)}
                      </p>
                    </div>
                    <div className="border border-rule bg-raised p-3">
                      <p className="text-xs text-muted">
                        {t("portfolio.noShares")}
                      </p>
                      <p className="mt-1 font-mono text-ink">
                        {position.walletNo.toFixed(4)}
                      </p>
                    </div>
                  </div>

                  <p className="mt-3 text-xs text-muted font-mono tabular-nums">
                    Total Shares: {totalShares.toFixed(4)} | YES Price:{" "}
                    {(position.priceYes * 100).toFixed(1)}%
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <ActiveOrdersCard />

      <Card className="bg-raised border border-rule p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-ink">
            {t("portfolio.lpPositions")}
          </h3>
          <span className="text-xs font-mono text-muted">
            {loadingLp
              ? t("common.loading")
              : `${lpPositions.length} ${t("portfolio.markets")}`}
          </span>
        </div>

        {loadingLp ? (
          <div className="border border-rule bg-inset p-4 text-sm text-muted">
            {t("portfolio.loadingLpPositions")}
          </div>
        ) : lpPositions.length === 0 ? (
          <div className="border border-rule bg-inset p-6 text-center space-y-3">
            <p className="text-sm text-muted">
              {t("portfolio.noLpPositions")}
            </p>
            <Link
              to="/create"
              className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-accent hover:underline"
            >
              Create a market to earn LP fees
              <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {lpPositions.map((position) => (
              <div
                key={position.marketAddress}
                className="border border-rule bg-inset p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink text-pretty">
                      {position.question}
                    </p>
                    <p className="text-xs text-muted mt-1">
                      {position.isLive
                        ? t("portfolio.liveLpPosition")
                        : t("portfolio.preLiveLpPosition")}
                    </p>
                  </div>
                  <div className="text-left sm:text-right">
                    <p className="text-xs text-muted">
                      {t("portfolio.shareOfPool")}
                    </p>
                    <p className="text-sm font-mono font-semibold text-ink">
                      {position.sharePercent.toFixed(2)}%
                    </p>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
                  <div className="border border-rule bg-raised p-3">
                    <p className="text-xs text-muted">
                      {t("portfolio.lpBalance")}
                    </p>
                    <p className="mt-1 font-mono text-ink">
                      {formatBigint(position.lpBalance, 18, 4)}
                    </p>
                  </div>
                  <div className="border border-rule bg-raised p-3">
                    <p className="text-xs text-muted">
                      {t("portfolio.floorValue")}
                    </p>
                    <p className="mt-1 font-mono text-ink">
                      ${formatBigint(position.floorValue, 6, 2)}
                    </p>
                  </div>
                  <div className="border border-rule bg-raised p-3">
                    <p className="text-xs text-muted">
                      {t("portfolio.ceilingValue")}
                    </p>
                    <p className="mt-1 font-mono text-ink">
                      ${formatBigint(position.ceilingValue, 6, 2)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};
