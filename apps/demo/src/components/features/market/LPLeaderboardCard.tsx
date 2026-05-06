// LPLeaderboardCard.tsx - Shows LP leaderboard with all LP holders
import React, { useState, useMemo } from "react";
import { Coins, HelpCircle } from "lucide-react";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { formatUnits } from "@/lib/chain-shim";
import { formatCurrency } from "../../../utils/format";
import { useLPHolders } from "../../../hooks/useLPHolders";
import { useBaseTokenDecimals } from "../../../hooks/useBaseTokenDecimals";
import { useTranslation } from "react-i18next";

interface LPHolder {
  address: `0x${string}`;
  balance: bigint;
}

interface LPLeaderboardCardProps {
  marketAddress?: `0x${string}`;
  userAddress?: `0x${string}`;
  userLpBalance?: bigint;
  userLpNetValue: bigint;
  userLpCeilingValue: bigint;
  userSharePercent: number;
  isLive?: boolean;
  redeemLP: (amount: bigint) => void;
  isRedeemLPPending: boolean;
  creatorAddress?: `0x${string}`;
  creatorLpBalance?: bigint;
  totalSupply?: bigint;
  totalAssets?: bigint;
  totalNetAssets?: bigint;
  totalLockedProceeds?: bigint;
  ammCashProp?: bigint;
  pureFloorProp?: bigint;
  pureCeilingProp?: bigint;
}

export const LPLeaderboardCard: React.FC<LPLeaderboardCardProps> = ({
  marketAddress,
  userAddress,
  userLpBalance,
  userLpNetValue,
  userLpCeilingValue,
  userSharePercent,
  isLive,
  redeemLP,
  isRedeemLPPending,
  creatorAddress,
  creatorLpBalance,
  totalSupply,
  totalAssets,
  totalNetAssets,
  totalLockedProceeds,
  ammCashProp,
  pureFloorProp,
  pureCeilingProp,
}) => {
  const [showHelp, setShowHelp] = useState(false);
  const { t } = useTranslation();
  const ASSET_DECIMALS = useBaseTokenDecimals();

  const { holders, isLoading: isLoadingHolders } = useLPHolders(
    marketAddress,
    creatorAddress,
  );

  const hasUserPosition =
    userAddress && userLpBalance !== undefined && userLpBalance > 0n;
  const isUserCreator =
    userAddress &&
    creatorAddress &&
    userAddress.toLowerCase() === creatorAddress.toLowerCase();

  const WAD_DECIMALS = 18;
  const LP_TOKEN_DECIMALS = 18;

  const calcNetValue = (balance: bigint) => {
    if (!totalSupply || totalSupply === 0n || !pureFloorProp) return 0n;
    return (balance * pureFloorProp) / totalSupply;
  };
  const calcCeilingValue = (balance: bigint) => {
    if (!totalSupply || totalSupply === 0n || !pureCeilingProp) return 0n;
    return (balance * pureCeilingProp) / totalSupply;
  };
  const calcShare = (balance: bigint) => {
    if (!totalSupply || totalSupply === 0n) return 0;
    return Number((balance * 10000n) / totalSupply) / 100;
  };

  const allHolders = useMemo(() => {
    const holderMap = new Map<string, bigint>();
    holders.forEach((h) => {
      holderMap.set(h.address.toLowerCase(), h.balance);
    });
    if (creatorAddress && creatorLpBalance !== undefined) {
      holderMap.set(creatorAddress.toLowerCase(), creatorLpBalance);
    }
    return Array.from(holderMap.entries())
      .map(([address, balance]) => ({
        address: address as `0x${string}`,
        balance,
      }))
      .filter((h) => h.balance > 0n)
      .sort((a, b) => (b.balance > a.balance ? 1 : -1));
  }, [holders, creatorAddress, creatorLpBalance]);

  const LeaderboardRow = ({
    address,
    balance,
    isCreatorRow,
    isYou,
  }: {
    address: string;
    balance: bigint;
    isCreatorRow?: boolean;
    isYou?: boolean;
  }) => {
    const share = calcShare(balance);
    const netVal = calcNetValue(balance);
    const ceilingVal = calcCeilingValue(balance);
    return (
      <div
        className={`flex items-center justify-between py-2.5 px-3 border transition-colors ${isYou ? "bg-accent-muted border-accent" : "bg-raised/30 border-rule"}`}
      >
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-ink truncate font-medium">
              {address.slice(0, 6)}...{address.slice(-4)}
            </span>
            {isCreatorRow && (
              <Badge
                className="text-[8px] py-0 px-1.5 h-4"
                style={{
                  backgroundColor: "var(--accent-muted)",
                  color: "var(--accent)",
                  borderColor: "var(--accent)",
                }}
              >
                {t("uc.lp.creator")}
              </Badge>
            )}
            {isYou && (
              <Badge
                className="text-[8px] py-0 px-1.5 h-4"
                style={{
                  backgroundColor: "var(--accent-muted)",
                  color: "var(--accent)",
                  borderColor: "var(--accent)",
                }}
              >
                {t("uc.lp.you")}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted font-mono">
            <span className="text-muted">
              {parseFloat(
                formatUnits(balance, LP_TOKEN_DECIMALS),
              ).toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}{" "}
              LP
            </span>
            <span className="opacity-30">•</span>
            <span className="text-muted font-bold">{share.toFixed(1)}%</span>
          </div>
        </div>
        <div className="flex flex-col items-end text-right min-w-[100px]">
          <div className="text-xs font-mono font-bold text-ink">
            {formatCurrency(parseFloat(formatUnits(netVal, ASSET_DECIMALS)))}
          </div>
          <div className="text-xs font-mono text-muted mt-0.5">
            {formatCurrency(
              parseFloat(formatUnits(ceilingVal, ASSET_DECIMALS)),
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <Card className="p-4 border-accent bg-raised">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold text-ink flex items-center gap-2 text-sm">
          <Coins className="w-4 h-4 text-ink" />
          {t("uc.lp.holders")}
        </h3>
        <div className="flex items-center gap-2">
          {hasUserPosition && !isLive && (
            <Badge className="text-xs bg-accent-muted text-ink border-accent">
              {t("uc.lp.redeemable")}
            </Badge>
          )}
          <button
            onClick={() => setShowHelp(!showHelp)}
            className={`p-1 rounded transition-colors ${showHelp ? "bg-accent-muted text-ink" : "text-muted hover:text-ink"}`}
          >
            <HelpCircle className="w-4 h-4" />
          </button>
        </div>
      </div>

      {showHelp && (
        <div className="p-3 bg-tooltip border border-rule mb-3 text-xs text-ink space-y-1">
          <p>
            • <strong>{t("uc.lp.floor")}</strong>: {t("uc.lp.floorDescription")}
          </p>
          <p>
            • <strong>{t("uc.lp.ceiling")}</strong>:{" "}
            {t("uc.lp.ceilingDescription")}
          </p>
          <p>
            • <strong>{t("uc.lp.fairMinting")}</strong>: {t("uc.lp.fairMintingDescription")}
          </p>
        </div>
      )}

      <div className="flex items-center justify-between px-3 pb-2 mb-1 font-mono text-xs text-muted uppercase tracking-[0.12em] tracking-widest border-b border-rule/50">
        <span>{t("uc.lp.holderShare")}</span>
        <div className="text-right">
          <span>
            {t("uc.lp.floor")} / {t("uc.lp.ceiling")}
          </span>
        </div>
      </div>

      <div className="space-y-1 mb-3 max-h-48 overflow-y-auto">
        {isLoadingHolders ? (
          <div className="text-center py-4 text-xs text-muted font-mono">
            {t("uc.common.loadingHolders")}
          </div>
        ) : allHolders.length > 0 ? (
          allHolders.map((holder) => (
            <LeaderboardRow
              key={holder.address}
              address={holder.address}
              balance={holder.balance}
              isCreatorRow={
                creatorAddress?.toLowerCase() === holder.address.toLowerCase()
              }
              isYou={
                userAddress?.toLowerCase() === holder.address.toLowerCase()
              }
            />
          ))
        ) : (
          <div className="text-center py-4 text-xs text-muted font-mono">
            {t("uc.common.noHolders")}
          </div>
        )}
      </div>

      {hasUserPosition && (
        <div className="pt-4 border-t border-rule space-y-4">
          <div className="bg-accent-muted p-3 border border-accent">
            <div className="flex items-center justify-between mb-3">
              <div className="flex flex-col">
                <span className="font-mono text-xs text-muted uppercase tracking-[0.12em] leading-none mb-1.5">
                  {isUserCreator
                    ? t("uc.lp.creatorFloor")
                    : t("uc.lp.yourFloor")}
                </span>
                <span className="font-mono font-bold text-ink text-xl leading-none">
                  {formatCurrency(
                    parseFloat(formatUnits(userLpNetValue, ASSET_DECIMALS)),
                  )}
                </span>
              </div>
              <div className="flex flex-col items-end">
                <span className="font-mono text-xs text-muted uppercase tracking-[0.12em] tracking-widest leading-none mb-1.5">
                  {t("uc.lp.ceilingValue")}
                </span>
                <span className="font-mono font-bold text-ink text-base leading-none">
                  {formatCurrency(
                    parseFloat(formatUnits(userLpCeilingValue, ASSET_DECIMALS)),
                  )}
                </span>
              </div>
            </div>
            <div className="flex items-center justify-between text-xs font-mono text-muted pt-2 border-t border-rule/50">
              <span>
                Position:{" "}
                {parseFloat(
                  formatUnits(userLpBalance || 0n, LP_TOKEN_DECIMALS),
                ).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}{" "}
                LP
              </span>
              <span className="text-muted font-bold">
                {userSharePercent.toFixed(1)}% Share
              </span>
            </div>
          </div>
          {!isLive && (
            <Button
              onClick={() => redeemLP(userLpBalance!)}
              disabled={isRedeemLPPending}
              className="btn btn-primary w-full"
            >
              {isRedeemLPPending
                ? "Redeeming..."
                : `Redeem LP ${t("uc.lp.floor")}`}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
};
