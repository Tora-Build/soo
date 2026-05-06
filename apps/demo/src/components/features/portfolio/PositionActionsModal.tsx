import React, { useState, useMemo } from "react";
import {
  useActivePositions,
  ActivePosition,
} from "../../../hooks/useActivePositions";
import {
  GitMerge,
  Scissors,
  ArrowUpRight,
  ArrowDownLeft,
  ChevronDown,
} from "lucide-react";
import { useAccount } from "@/lib/chain-shim";
import toast from "react-hot-toast";
import { Dialog } from "../../ui/Dialog";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";
import { useTraderVault } from "../../../hooks/useTraderVault";
import { formatUnits } from "@/lib/chain-shim";
import { useLaunchpadMarkets } from "../../../hooks/useLaunchpadMarkets";
import { cn } from "../../../lib/utils";

export const PositionActionsModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  pos?: ActivePosition;
  marketAddress?: string;
  mode: "merge" | "split";
  refetch: () => void;
}> = ({ isOpen, onClose, pos, marketAddress, mode, refetch }) => {
  const { address } = useAccount();
  const {
    availableBalance,
    decimals,
    refetch: refetchVault,
  } = useTraderVault();
  const { markets } = useLaunchpadMarkets();
  const { vaultPositions } = useActivePositions();

  const [selectedMarketAddr, setSelectedMarketAddr] = useState<
    `0x${string}` | null
  >(null);
  const [amount, setAmount] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // If marketAddress is provided, use it to find the market
  const explicitMarket = marketAddress
    ? markets.find(
        (m) => m.address.toLowerCase() === marketAddress.toLowerCase(),
      )
    : null;

  // Find if we have an active wallet position for this market
  const activeVaultPos = useMemo(() => {
    const addr = marketAddress || selectedMarketAddr;
    if (!addr) return null;
    return vaultPositions.find(
      (p) => p.marketAddress.toLowerCase() === addr.toLowerCase(),
    );
  }, [vaultPositions, marketAddress, selectedMarketAddr]);

  // If pos is provided, use it. Otherwise use active market data from wallet positions or market list.
  const activeMarket =
    pos ||
    activeVaultPos ||
    (explicitMarket
      ? {
          outcomeTokenAddress: explicitMarket.outcomeToken,
          marketAddress: explicitMarket.address as `0x${string}`,
          liquidYes: 0,
          liquidNo: 0,
          walletYes: 0,
          walletNo: 0,
          question:
            explicitMarket.question || explicitMarket.name || "Current Market",
        }
      : selectedMarketAddr
        ? {
            outcomeTokenAddress: markets.find(
              (m) => m.address === selectedMarketAddr,
            )?.outcomeToken,
            marketAddress: selectedMarketAddr,
            liquidYes: 0,
            liquidNo: 0,
            walletYes: 0,
            walletNo: 0,
            question:
              markets.find((m) => m.address === selectedMarketAddr)?.question ||
              markets.find((m) => m.address === selectedMarketAddr)?.name ||
              "Selected Market",
          }
        : null);

  // For Merge: use wallet YES/NO balances. For Split: use wallet USDC balance.
  const available =
    mode === "merge"
      ? activeMarket
        ? Math.min(activeMarket.walletYes || 0, activeMarket.walletNo || 0)
        : 0
      : parseFloat(formatUnits(availableBalance, decimals));

  const handleAction = async () => {
    if (!amount || parseFloat(amount) <= 0 || !activeMarket || !address) return;
    setIsLoading(true);
    const toastId = mode === "merge" ? "merge" : "split";

    try {
      toast.loading("Action unavailable here in V12 wallet mode.", {
        id: toastId,
      });
      await Promise.resolve();
      toast.success("No action executed.", { id: toastId });
      refetch();
      refetchVault();

      onClose();
    } catch (e: any) {
      toast.error(
        e.message?.split("\n")[0] ||
          `${mode === "merge" ? "Merge" : "Split"} failed`,
        { id: toastId },
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          {mode === "merge" ? (
            <ArrowUpRight size={16} className="text-ink" />
          ) : (
            <ArrowDownLeft size={16} className="text-muted" />
          )}
          <span>{mode === "merge" ? "Merge Shares" : "Split USDC"}</span>
        </div>
      }
    >
      <div className="space-y-4 pt-4">
        {!pos && !marketAddress && mode === "split" && (
          <div className="space-y-1.5">
            <label className="font-mono text-xs text-muted uppercase tracking-[0.12em] tracking-wider ml-1">
              Target Market
            </label>
            <div className="relative">
              <select
                className="input-field w-full h-10 px-3 text-xs appearance-none pr-10"
                value={selectedMarketAddr || ""}
                onChange={(e) =>
                  setSelectedMarketAddr(e.target.value as `0x${string}`)
                }
              >
                <option value="" disabled>
                  Select market to split...
                </option>
                {markets.map((m) => (
                  <option key={m.address} value={m.address}>
                    {m.question || m.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                className="absolute right-3 top-3 text-muted pointer-events-none"
              />
            </div>
          </div>
        )}

        <div
          className={cn(
            "p-3 border",
            mode === "merge"
              ? "bg-accent-muted border-accent"
              : "bg-accent-muted border-accent/10",
          )}
        >
          <div className="flex justify-between items-center mb-2">
            <div
              className={cn(
                "font-mono text-xs uppercase tracking-[0.12em] flex items-center gap-1.5",
                mode === "merge" ? "text-muted" : "text-accent/60",
              )}
            >
              {mode === "merge" ? (
                <GitMerge size={10} />
              ) : (
                <Scissors size={10} />
              )}
              {mode === "merge" ? "Collapsible Position" : "Leveraged Exposure"}
            </div>
            <div className="text-xs text-ink font-mono font-bold">
              {mode === "merge" ? "1 SET → $1.00" : "$1.00 → 1 SET"}
            </div>
          </div>
          <p className="text-xs text-muted leading-relaxed">
            {mode === "merge" ? (
              <>
                Converts{" "}
                <span className="text-ink font-bold">1 YES + 1 NO</span> from
                your wallet position into{" "}
                <span className="text-ink font-bold">$1.00 USDC</span> when
                merge is available.
              </>
            ) : (
              <>
                Converts <span className="text-ink font-bold">$1.00 USDC</span>{" "}
                from wallet collateral into{" "}
                <span className="text-accent font-bold">1 YES + 1 NO</span> when
                split is available.
              </>
            )}
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="relative">
            <Input
              placeholder="0"
              value={amount}
              onChange={(e) => {
                // Enforce integer-only for both split and merge (shares are integers)
                const intVal = Math.floor(parseFloat(e.target.value) || 0);
                setAmount(intVal > 0 ? intVal.toString() : "");
              }}
              type="number"
              step="1"
              className={cn(
                "pr-16 font-mono",
                mode === "merge"
                  ? "focus:border-accent"
                  : "focus:border-accent",
              )}
              disabled={!activeMarket}
            />
            <button
              onClick={() => setAmount(Math.floor(available).toString())}
              className={cn(
                "absolute right-2 top-2 px-2 py-1 bg-raised text-xs rounded hover:bg-raised font-bold transition-colors disabled:opacity-50",
                mode === "merge" ? "text-ink" : "text-accent",
              )}
              disabled={!activeMarket}
            >
              MAX
            </button>
          </div>
          <div className="flex justify-between items-center px-1">
            <span className="font-mono text-xs text-muted uppercase tracking-[0.12em] tracking-wider">
              {mode === "merge" ? "In Wallet Position" : "USDC in Wallet"}
            </span>
            <span
              className={cn(
                "text-xs font-mono font-bold",
                mode === "merge" ? "text-ink" : "text-accent",
              )}
            >
              {mode === "merge"
                ? `${Math.floor(available)} SETS`
                : `$${Math.floor(available).toLocaleString()}`}
            </span>
          </div>
        </div>

        <Button
          onClick={handleAction}
          isLoading={isLoading}
          disabled={
            !amount ||
            parseFloat(amount) > available + 0.000001 ||
            !activeMarket
          }
          className={cn(
            "w-full",
            mode === "merge" ? "btn btn-secondary" : "btn btn-primary",
          )}
        >
          {mode === "merge" ? "Confirm Merge" : "Confirm Split"}
        </Button>
      </div>
    </Dialog>
  );
};
