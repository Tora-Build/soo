import { useAccount, useChainId } from "@/lib/chain-shim";
import { formatUnits, encodePacked, keccak256 } from "@/lib/chain-shim";
import {
  ERC20_ABI,
  LAUNCHPAD_MARKET_ABI,
  LAUNCHPAD_OUTCOME_TOKEN_ABI,
  SOOTHBOOK_ABI,
  ABIS,
} from "../config/abis";
import { useLaunchpadMarkets } from "./useLaunchpadMarkets";
import { useMemo } from "react";
import { getPollingInterval } from "../lib/polling";
import { useDirectRead, readContractSafe } from "./useDirectRead";
import { useDeployments } from "./useDeployments";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export interface ActivePosition {
  id: string;
  question: string;
  marketAddress: `0x${string}`;
  outcomeTokenAddress?: `0x${string}`;
  liquidYes: number;
  liquidNo: number;
  lockedYes: number;
  lockedNo: number;
  walletYes: number;
  walletNo: number;
  unlockTime: number;
  value: number;
  priceYes: number;
  isSettled: boolean;
  winningOutcome: number | null;
}

export const useActivePositions = () => {
  const { address } = useAccount();
  const chainId = useChainId();
  const { markets: launchpadMarkets } = useLaunchpadMarkets();
  const { contracts } = useDeployments();
  const soothBookAddress = contracts.SoothBook as `0x${string}` | undefined;
  const ammEngineAddress = contracts.AMMEngine as `0x${string}` | undefined;

  const uniqueMarkets = useMemo(() => {
    const list: {
      address: `0x${string}`;
      name: string;
      question?: string;
      outcomeToken?: `0x${string}`;
      isGraduated: boolean;
    }[] = [];
    const seen = new Set<string>();

    if (launchpadMarkets) {
      launchpadMarkets.forEach((market) => {
        if (market.address && !seen.has(market.address.toLowerCase())) {
          seen.add(market.address.toLowerCase());
          list.push({
            address: market.address,
            name: market.question || market.name,
            question: market.question,
            outcomeToken: market.outcomeToken,
            isGraduated: Boolean(market.isGraduated),
          });
        }
      });
    }

    return list;
  }, [launchpadMarkets]);

  const marketScope = useMemo(
    () =>
      uniqueMarkets.map(
        (m) => `${m.address}:${m.outcomeToken ?? ""}:${m.isGraduated ? 1 : 0}`,
      ),
    [uniqueMarkets],
  );

  const positionsQuery = useDirectRead<ActivePosition[]>({
    queryKey: [
      "v12",
      "activePositions",
      chainId,
      address,
      soothBookAddress,
      ammEngineAddress,
      marketScope,
    ],
    enabled: !!address && uniqueMarkets.length > 0,
    chainId,
    refetchInterval: getPollingInterval(chainId, "slow"),
    staleTime: 10_000,
    read: async (client) => {
      if (!address) return [];

      const positions = await Promise.all(
        uniqueMarkets.map(async (market): Promise<ActivePosition | null> => {
          const isSettled = await readContractSafe<boolean>(client, {
            address: market.address,
            abi: LAUNCHPAD_MARKET_ABI,
            functionName: "isSettled",
          }).catch(() => false);

          let winningOutcome: number | null = null;
          if (isSettled) {
            const rawOutcome = await readContractSafe<number | bigint>(client, {
              address: market.address,
              abi: LAUNCHPAD_MARKET_ABI,
              functionName: "winningOutcome",
            }).catch(() => null);
            if (rawOutcome !== null && rawOutcome !== undefined) {
              winningOutcome = Number(rawOutcome);
            }
          }

          let walletYesRaw = 0n;
          let walletNoRaw = 0n;
          let priceYes = 0.5;

          if (market.isGraduated && soothBookAddress) {
            const marketKey = keccak256(
              encodePacked(["address"], [market.address]),
            );

            // SoothBook.markets returns only state flags (active, finalized,
            // outcome) — no token addresses. YES/NO ERC20 balances live in
            // market.outcomeToken (handled in the unconditional branch
            // below). The AMM position is captured via AMMEngine.getPosition
            // at the end of this function.
            const implied = await readContractSafe<readonly [bigint, bigint]>(
              client,
              {
                address: soothBookAddress,
                abi: SOOTHBOOK_ABI,
                functionName: "getImpliedPriceByKey",
                args: [marketKey],
              },
            ).catch(() => null);

            if (implied?.[0] !== undefined) {
              priceYes = Number(formatUnits(implied[0], 18));
            }
          } else {
            if (market.outcomeToken && market.outcomeToken !== ZERO_ADDRESS) {
              // Protocol convention: outcome id 0 = NO, 1 = YES.
              const [noBalance, yesBalance] = await Promise.all([
                readContractSafe<bigint>(client, {
                  address: market.outcomeToken,
                  abi: LAUNCHPAD_OUTCOME_TOKEN_ABI,
                  functionName: "balanceOf",
                  args: [address, 0n],
                }).catch(() => 0n),
                readContractSafe<bigint>(client, {
                  address: market.outcomeToken,
                  abi: LAUNCHPAD_OUTCOME_TOKEN_ABI,
                  functionName: "balanceOf",
                  args: [address, 1n],
                }).catch(() => 0n),
              ]);

              walletYesRaw = yesBalance;
              walletNoRaw = noBalance;
            }

            const ammPrice = await readContractSafe<bigint>(client, {
              address: market.address,
              abi: LAUNCHPAD_MARKET_ABI,
              functionName: "price",
              args: [0],
            }).catch(() => null);

            if (ammPrice !== null) {
              priceYes = Number(formatUnits(ammPrice, 18));
            }
          }

          // AMM positions are tracked in AMMEngine.getPosition (not on the
          // outcome ERC1155 token or SoothBook balance). Read them for ALL
          // markets so users see their AMM trades in the portfolio whether
          // or not the market is graduated. Add to whatever we read above.
          if (ammEngineAddress) {
            const ammPos = await readContractSafe<readonly [bigint, bigint]>(
              client,
              {
                address: ammEngineAddress,
                abi: ABIS.AMMEngine,
                functionName: "getPosition",
                args: [market.address, address],
              },
            ).catch(() => null);
            if (ammPos) {
              walletYesRaw += ammPos[0];
              walletNoRaw += ammPos[1];
            }
          }

          const walletYes = Number(formatUnits(walletYesRaw, 18));
          const walletNo = Number(formatUnits(walletNoRaw, 18));
          const totalYes = walletYes;
          const totalNo = walletNo;

          if (totalYes <= 0.001 && totalNo <= 0.001) {
            return null;
          }

          const priceNo = 1 - priceYes;
          const value = totalYes * priceYes + totalNo * priceNo;

          return {
            id: market.address,
            question: market.question || market.name,
            marketAddress: market.address,
            outcomeTokenAddress: market.outcomeToken,
            liquidYes: 0,
            liquidNo: 0,
            lockedYes: 0,
            lockedNo: 0,
            walletYes,
            walletNo,
            unlockTime: 0,
            value,
            priceYes,
            isSettled,
            winningOutcome,
          };
        }),
      );

      return positions.filter(
        (position): position is ActivePosition => position !== null,
      );
    },
  });

  return useMemo(() => {
    const vaultPositions = positionsQuery.data ?? [];
    const vaultValue = vaultPositions.reduce(
      (sum, position) => sum + position.value,
      0,
    );

    return {
      vaultPositions,
      vaultValue,
      totalPositionValue: vaultValue,
      refetch: positionsQuery.refetch,
      isLoading: positionsQuery.isLoading,
    };
  }, [positionsQuery.data, positionsQuery.refetch, positionsQuery.isLoading]);
};
