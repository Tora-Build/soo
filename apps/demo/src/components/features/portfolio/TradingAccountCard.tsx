import React, { useState } from "react";
import { Card } from "../../ui/Card";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Input } from "../../ui/Input";
import {
  RefreshCw,
  Wallet,
  ArrowDownLeft,
  Coins,
  Lock,
  TrendingUp,
} from "lucide-react";
import { useAccount } from "@/lib/chain-shim";
import { formatUnits, parseUnits } from "@/lib/chain-shim";
import { useTraderVault } from "../../../hooks/useTraderVault";
import { useActivePositions } from "../../../hooks/useActivePositions";
import { useLockedFunds } from "../../../hooks/useLockedFunds";
import { PositionActionsModal } from "./PositionActionsModal";
import { formatCurrencyCompact } from "../../../lib/utils";
import { useTranslation } from "react-i18next";

export const TradingAccountCard: React.FC = () => {
  const { t } = useTranslation();
  const { isConnected } = useAccount();

  // Trading Account data
  const {
    availableBalance,
    reservedBalance,
    claimableBalance,
    withdrawBookCredit,
    claimSettled,
    totalBalance,
    userUsdcBalance,
    decimals,
    allowance,
    approveUSDC,
    isPending,
    deposit,
  } = useTraderVault();
  const { vaultValue, refetch: refetchPositions } = useActivePositions();
  const { refetch: refetchLocked } = useLockedFunds();

  // Dialog State
  const [depositAmount, setDepositAmount] = useState<string | bigint>("");
  const [isDepositOpen, setIsDepositOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"merge" | "split" | null>(null);

  const formatCurrency = (val: number) => formatCurrencyCompact(val);

  const available = parseFloat(formatUnits(availableBalance, decimals));
  const reserved = parseFloat(formatUnits(reservedBalance, decimals));
  // Refunds from cancelled orders. Cancelling does not return USDC to the
  // wallet — it lands in the trader's seat inside the book — so without this
  // the money simply disappears from view until they withdraw it.
  const claimable = parseFloat(formatUnits(claimableBalance ?? 0n, decimals));
  const cashValue = parseFloat(formatUnits(totalBalance, decimals));
  const totalAccountValue = cashValue + vaultValue;
  const walletAvailable = parseFloat(
    formatUnits(userUsdcBalance || 0n, decimals),
  );

  // Checking Allowance for Deposit
  const depositAmountBig =
    typeof depositAmount === "string"
      ? depositAmount
        ? parseUnits(depositAmount, decimals)
        : 0n
      : depositAmount;
  const needsApproval = (allowance || 0n) < depositAmountBig;

  const handleRefresh = () => {
    refetchPositions();
    refetchLocked();
  };

  const onDeposit = async () => {
    if (
      !depositAmount ||
      (typeof depositAmount === "string" && !parseFloat(depositAmount))
    )
      return;
    try {
      if (needsApproval) {
        await approveUSDC(
          typeof depositAmount === "string"
            ? depositAmount
            : formatUnits(depositAmount, decimals),
        );
      } else {
        await deposit(depositAmount);
        setDepositAmount("");
        setIsDepositOpen(false);
      }
    } catch (e) {
      // Error handled in hook
    }
  };

  if (!isConnected) {
    return (
      <Card className="h-full border-rule bg-raised p-6 flex flex-col items-center justify-center text-center">
        <Wallet className="w-10 h-10 text-faint mb-3" />
        <h3 className="text-sm font-medium text-muted">
          {t("common.connectWallet")}
        </h3>
        <p className="text-xs text-muted mt-1">
          {t("portfolio.connectDescription")}
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col border-rule bg-raised overflow-visible relative">
      <div className="p-4 flex flex-col space-y-4 relative z-10">
        {/* Header: Overview */}
        <div>
          <div className="flex justify-between items-center mb-1.5">
            <div className="font-mono text-xs text-muted uppercase tracking-[0.12em] flex items-center gap-1.5">
              {t("portfolio.tradingAccount")}
              <button
                onClick={handleRefresh}
                className="text-faint hover:text-accent transition-colors"
                title={t("portfolio.refreshBalance")}
              >
                <RefreshCw size={10} />
              </button>
            </div>
            <div
              className="text-xs text-muted font-medium flex items-center gap-1"
              title={t("portfolio.walletUsdcBalance")}
            >
              <Wallet size={9} className="text-faint" />
              {formatCurrency(walletAvailable)}
            </div>
          </div>
          <p className="text-xs text-faint mt-1">
            {t("portfolio.depositInstruction")}
          </p>

          <div className="flex flex-col gap-4">
            {/* Total Balance Big Number */}
            <div className="text-3xl font-bold text-ink font-mono tracking-tighter leading-none">
              {formatCurrency(totalAccountValue)}
            </div>

            {/* Action Buttons Grid */}
            <div className="flex flex-col gap-2">
              {allowance === 0n ? (
                <>
                  <div className="font-mono text-xs text-muted uppercase tracking-[0.12em] flex items-center gap-1">
                    {t("portfolio.walletCollateral")} •{" "}
                    {t("portfolio.soothBookApproval")}
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setIsDepositOpen(true)}
                    className="group"
                  >
                    <ArrowDownLeft
                      size={12}
                      className="mr-1 opacity-70 group-hover:-translate-x-0.5 group-hover:translate-y-0.5 transition-transform"
                    />{" "}
                    {t("trading.approveUsdc")}
                  </Button>
                </>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="font-mono text-xs text-muted uppercase tracking-[0.12em] flex items-center gap-1">
                    {t("portfolio.walletCollateral")} •{" "}
                    {t("portfolio.readyToTrade")}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-ink font-bold">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent inline-block" />
                    {t("portfolio.approved")}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Detailed Breakdown — single inline row */}
        <div className="flex items-stretch gap-1.5">
          {/* Liquid Cash */}
          <div className="flex-1 flex flex-col justify-between p-3">
            <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted flex items-center gap-1">
              <Coins size={9} className="text-faint" />{" "}
              {t("portfolio.liquid")}
            </div>
            <div className="font-mono text-sm text-ink leading-none mt-1">
              {formatCurrency(available)}
            </div>
          </div>

          {/* Reserved (Collateral) */}
          <div
            className="flex-1 flex flex-col justify-between p-3"
            title={t("portfolio.reservedTooltip")}
          >
            <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted flex items-center gap-1">
              <Lock size={9} className="text-faint" />{" "}
              {t("portfolio.reserved")}
            </div>
            <div className="font-mono text-sm text-ink leading-none mt-1">
              {formatCurrency(reserved)}
            </div>
          </div>

          {/* Claimable — refunds from cancelled orders.
              Shown only when non-zero: an always-visible $0.00 row trains the
              eye to skip it, and this is money the trader has to act on. */}
          {claimable > 0 && (
            <div
              className="flex-1 flex flex-col justify-between p-3"
              title="Refunds from cancelled orders. Cancelling returns collateral to your book account, not your wallet — withdraw to move it back."
            >
              <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted flex items-center gap-1">
                <ArrowDownLeft size={9} className="text-faint" /> Claimable
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="font-mono text-sm text-pos leading-none">
                  {formatCurrency(claimable)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5 text-[10px]"
                  disabled={isPending}
                  onClick={() => void withdrawBookCredit?.()}
                >
                  Withdraw
                </Button>
              </div>
            </div>
          )}

          {/* Post-settlement claims.
              Separate from Claimable above, which is USDC already released.
              These convert a settled POSITION into money, and the subsidy one
              only succeeds for a market's creator. */}
          <div className="flex-1 flex flex-col justify-between p-3">
            <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted flex items-center gap-1">
              <Coins size={9} className="text-faint" /> Settled
            </div>
            <div className="flex items-center gap-1 mt-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1.5 text-[10px]"
                disabled={isPending}
                onClick={() => void claimSettled?.("redeemBookSeat")}
                title="Convert a settled book position into USDC"
              >
                Redeem
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1.5 text-[10px]"
                disabled={isPending}
                onClick={() => void claimSettled?.("reclaimSubsidy")}
                title="Creator only: return the unspent LMSR subsidy"
              >
                Subsidy
              </Button>
            </div>
          </div>

          {/* Position Value */}
          <div className="flex-1 flex flex-col justify-between p-3">
            <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted flex items-center gap-1">
              <TrendingUp size={9} className="text-faint" />{" "}
              {t("portfolio.positions")}
            </div>
            <div className="font-mono text-sm text-ink leading-none mt-1">
              {formatCurrency(vaultValue)}
            </div>
          </div>
        </div>
      </div>

      {/* Dialogs */}
      <Dialog
        isOpen={isDepositOpen}
        onClose={() => setIsDepositOpen(false)}
        title={t("portfolio.approveUsdcForSoothBook")}
      >
        <div className="space-y-4 pt-4">
          <div className="relative">
            <Input
              value={
                typeof depositAmount === "bigint"
                  ? formatUnits(depositAmount, decimals)
                  : depositAmount
              }
              onChange={(e) => setDepositAmount(e.target.value)}
              type="number"
              placeholder={t("portfolio.amountToApprove")}
            />
            <button
              onClick={() => setDepositAmount(userUsdcBalance || 0n)}
              className="absolute right-2 top-2 px-2 py-1 bg-raised text-xs text-accent rounded hover:bg-raised font-bold transition-colors"
            >
              {t("common.max")}
            </button>
          </div>
          <div className="text-xs text-muted text-right">
            {t("portfolio.walletUsdcBalance")}: {formatCurrency(walletAvailable)}
          </div>

          <Button
            onClick={onDeposit}
            disabled={isPending || !depositAmount}
            className="w-full py-2 text-sm font-bold"
          >
            {isPending
              ? t("portfolio.processing")
              : needsApproval
                ? t("common.approveUsdc")
                : t("portfolio.walletModeActive")}
          </Button>
          <p className="text-xs text-muted">
            {t("portfolio.directWalletSettlement")}
          </p>
        </div>
      </Dialog>

      <PositionActionsModal
        isOpen={modalMode !== null}
        onClose={() => setModalMode(null)}
        mode={modalMode || "merge"}
        refetch={() => {
          refetchPositions();
          refetchLocked();
        }}
      />
    </Card>
  );
};
