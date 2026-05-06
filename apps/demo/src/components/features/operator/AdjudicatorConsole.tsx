import React, { useMemo, useState } from "react";
import {
  useAccount,
  useReadContracts,
  useWriteContract,
  usePublicClient,
} from "@/lib/chain-shim";
import { formatUnits, parseUnits } from "@/lib/chain-shim";
import {
  LAUNCHPAD_MARKET_ABI,
  SOOTH_MANUAL_ADJUDICATOR_ABI,
  SOOTH_OPTIMISTIC_ADJUDICATOR_ABI,
} from "../../../config/abis";
import { useLaunchpadMarkets } from "../../../hooks/useLaunchpadMarkets";
import { useTranslation } from "react-i18next";
import { useChainStore } from "../../../store/useChainStore";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import toast from "react-hot-toast";
import { logger } from "../../../lib/logger";

export function AdjudicatorConsole() {
  const { t } = useTranslation();
  const { selectedChainId } = useChainStore();
  const { markets, isLoading: isLoadingMarkets } = useLaunchpadMarkets();
  const { address: userAddress } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const [resolving, setResolving] = useState<Record<string, boolean>>({});
  const [outcomes, setOutcomes] = useState<Record<string, 0 | 1>>({});
  const [tStars, setTStars] = useState<Record<string, string>>({});

  // Fetch market adjudicator states
  const marketCalls = useMemo(() => {
    return markets.flatMap((m) => [
      {
        address: m.address,
        abi: LAUNCHPAD_MARKET_ABI,
        functionName: "adjudicator",
        chainId: Number(selectedChainId),
      },
      {
        address: m.address,
        abi: LAUNCHPAD_MARKET_ABI,
        functionName: "isSettled",
        chainId: Number(selectedChainId),
      },
      {
        address: m.address,
        abi: LAUNCHPAD_MARKET_ABI,
        functionName: "winningOutcome",
        chainId: Number(selectedChainId),
      },
      {
        address: m.address,
        abi: LAUNCHPAD_MARKET_ABI,
        functionName: "tStar",
        chainId: Number(selectedChainId),
      },
    ]);
  }, [markets, selectedChainId]);

  const {
    data: marketStates,
    isLoading: isLoadingStates,
    refetch: refetchStates,
  } = useReadContracts({
    contracts: marketCalls,
    query: { enabled: markets.length > 0 },
  });

  const handleResolve = async (
    marketAddress: `0x${string}`,
    adjudicatorAddress: `0x${string}`,
  ) => {
    const outcome = outcomes[marketAddress] ?? 0;

    // V7: tStar is a truth-time (Unix timestamp)
    // Default to current time if not provided
    const tStarStr = tStars[marketAddress];
    const tStar = tStarStr
      ? BigInt(Math.floor(Number(tStarStr)))
      : BigInt(Math.floor(Date.now() / 1000));

    setResolving((prev) => ({ ...prev, [marketAddress]: true }));
    const toastId = toast.loading("Resolving market...");

    try {
      // V7 Settlement Logic:
      // 1. If the adjudicator is an EOA (e.g. the user themselves), call finalizeResolution on the market.
      // 2. If the adjudicator is a contract, call resolve() on that contract.

      const isEoaAdjudicator =
        adjudicatorAddress.toLowerCase() === userAddress?.toLowerCase();

      if (isEoaAdjudicator) {
        const hash = await writeContractAsync({
          address: marketAddress,
          abi: LAUNCHPAD_MARKET_ABI,
          functionName: "finalizeResolution",
          args: [outcome, tStar],
        });
        await publicClient?.waitForTransactionReceipt({ hash });
      } else {
        const hash = await writeContractAsync({
          address: adjudicatorAddress,
          abi: SOOTH_MANUAL_ADJUDICATOR_ABI,
          functionName: "resolve",
          args: [
            marketAddress,
            outcome,
            "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
            tStar,
          ],
        });
        await publicClient?.waitForTransactionReceipt({ hash });
      }

      toast.success("Market resolved!", { id: toastId });
      refetchStates();
    } catch (error: any) {
      logger.market.error("Resolution error:", error);
      toast.error(error.message?.split("\n")[0] || "Resolution failed", {
        id: toastId,
      });
    } finally {
      setResolving((prev) => ({ ...prev, [marketAddress]: false }));
    }
  };

  if (isLoadingMarkets || isLoadingStates) {
    return (
      <div className="text-muted font-mono italic">Loading markets...</div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4">
        {markets.map((market, i) => {
          const baseIdx = i * 4;
          const adjudicator = marketStates?.[baseIdx]?.result as `0x${string}`;
          const isSettled = !!marketStates?.[baseIdx + 1]?.result;
          const winningOutcome = marketStates?.[baseIdx + 2]?.result as number;
          const tStarVal = marketStates?.[baseIdx + 3]?.result as bigint;

          return (
            <Card
              key={market.address}
              data-testid={`operator-market-card-${market.address.toLowerCase()}`}
              className="p-6 bg-raised border-rule"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-bold text-ink">
                      {market.question || market.name}
                    </h3>
                    <Badge variant={isSettled ? "success" : "indigo"}>
                      {isSettled ? t("trading.settled") : t("trading.trading")}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted font-mono">
                    {market.address}
                  </p>
                  <p className="text-xs text-muted font-mono">
                    Adjudicator:{" "}
                    <span className="text-accent">{adjudicator}</span>
                  </p>
                </div>

                {!isSettled ? (
                  <div className="flex flex-wrap items-center gap-4 bg-inset p-4 border border-rule">
                    <div className="flex items-center gap-2">
                      <label className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
                        Outcome
                      </label>
                      <select
                        data-testid="operator-outcome-select"
                        className="input-field text-sm px-2 py-1"
                        value={outcomes[market.address] ?? 1}
                        onChange={(e) =>
                          setOutcomes((prev) => ({
                            ...prev,
                            [market.address]: Number(e.target.value) as 0 | 1,
                          }))
                        }
                      >
                        {/* Protocol encoding: YES=1, NO=0 (knowledge.md).
                            The dropdown was previously inverted — YES had
                            value=0 which is NO on-chain. Default selected
                            value flipped to 1 to match. */}
                        <option value={1}>YES</option>
                        <option value={0}>NO</option>
                      </select>
                    </div>

                    <div className="flex items-center gap-2">
                      <label className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
                        T* (Time)
                      </label>
                      <Input
                        type="text"
                        placeholder={Math.floor(Date.now() / 1000).toString()}
                        className="w-32 h-8 bg-raised font-mono text-xs"
                        value={tStars[market.address] || ""}
                        onChange={(e) =>
                          setTStars((prev) => ({
                            ...prev,
                            [market.address]: e.target.value,
                          }))
                        }
                      />
                    </div>

                    <Button
                      data-testid="operator-resolve-button"
                      size="sm"
                      variant="primary"
                      onClick={() => handleResolve(market.address, adjudicator)}
                      disabled={resolving[market.address] || !adjudicator}
                    >
                      {resolving[market.address]
                        ? "..."
                        : t("operator.resolve")}
                    </Button>
                  </div>
                ) : (
                  <div className="text-right">
                    <div className="font-mono text-xs uppercase tracking-[0.12em] text-muted mb-1">
                      Result
                    </div>
                    <div className="text-ink font-mono">
                      Winner:{" "}
                      <span
                        className={
                          winningOutcome === 0 ? "text-ink" : "text-muted"
                        }
                      >
                        {winningOutcome === 0 ? "YES" : "NO"}
                      </span>
                      <span className="mx-2 text-faint">|</span>
                      T*:{" "}
                      <span className="text-accent">
                        {formatUnits(tStarVal || 0n, 18)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
