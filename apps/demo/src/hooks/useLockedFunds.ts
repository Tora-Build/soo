import { useAccount, useChainId } from "@/lib/chain-shim";
import { useCallback, useMemo } from "react";
import { ERC20_ABI, LAUNCHPAD_MARKET_ABI } from "../config/abis";
import { useDeployments } from "./useDeployments";
import { useLaunchpadMarkets } from "./useLaunchpadMarkets";
import { formatUnits, parseAbi } from "@/lib/chain-shim";
import { getPollingInterval } from "../lib/polling";
import { useDirectRead, readContractSafe } from "./useDirectRead";

const LOCK_READ_ABI = parseAbi([
  "function lockedBalance(address user) view returns (uint256)",
  "function claimableBalance(address user) view returns (uint256)",
  "function nextUnlock(address user) view returns (uint256 amount, uint64 unlockTime)",
  "function getLockEntries(address user) view returns (uint256[] amounts, uint64[] unlockTimes)",
]);

export interface UseLockedFundsResult {
  locked: bigint;
  claimable: bigint;
  available: bigint;
  pending: bigint;
  total: bigint;
  vaultLocked: bigint;
  marketLocked: bigint;
  decimals: number;
  nextUnlockAmount: bigint;
  nextUnlockTimestamp: number;
  entries: LockEntry[];
  lockedFormatted: string;
  claimableFormatted: string;
  availableFormatted: string;
  pendingFormatted: string;
  totalFormatted: string;
  nextUnlockFormatted: string;
  timeRemaining: string;
  isLoading: boolean;
  isClaiming: boolean;
  hasClaimable: boolean;
  claim: () => Promise<void>;
  refetch: () => void;
}

export interface LockEntry {
  amount: bigint;
  unlockTime: number;
  isClaimable: boolean;
  timeRemaining: number;
  marketAddress?: `0x${string}`;
  marketName?: string;
}

interface LockedFundsData {
  locked: bigint;
  claimable: bigint;
  available: bigint;
  pending: bigint;
  total: bigint;
  vaultLocked: bigint;
  marketLocked: bigint;
  decimals: number;
  nextUnlockAmount: bigint;
  nextUnlockTimestamp: number;
  entries: LockEntry[];
}

export function useLockedFunds(): UseLockedFundsResult {
  const { address } = useAccount();
  const chainId = useChainId();
  const { config } = useDeployments();
  const contracts = config.contracts;
  const { markets, isLoading: marketsLoading } = useLaunchpadMarkets();

  const uniqueMarkets = useMemo(() => {
    const list: { address: `0x${string}`; name: string }[] = [];
    const seen = new Set<string>();

    if (markets) {
      markets.forEach((market) => {
        if (market.address && !seen.has(market.address.toLowerCase())) {
          seen.add(market.address.toLowerCase());
          list.push({
            address: market.address,
            name: market.question || market.name,
          });
        }
      });
    }

    return list;
  }, [markets]);

  const marketScope = useMemo(
    () => uniqueMarkets.map((m) => m.address),
    [uniqueMarkets],
  );

  const lockQuery = useDirectRead<LockedFundsData>({
    queryKey: [
      "v12",
      "lockedFunds",
      chainId,
      address,
      contracts?.MockUSDC,
      marketScope,
    ],
    enabled: !!address && !!contracts?.MockUSDC,
    chainId,
    refetchInterval: getPollingInterval(chainId, "slow"),
    staleTime: 10_000,
    read: async (client) => {
      if (!address || !contracts?.MockUSDC) {
        return {
          locked: 0n,
          claimable: 0n,
          available: 0n,
          pending: 0n,
          total: 0n,
          vaultLocked: 0n,
          marketLocked: 0n,
          decimals: 6,
          nextUnlockAmount: 0n,
          nextUnlockTimestamp: 0,
          entries: [],
        };
      }

      const usdcAddress = contracts.MockUSDC as `0x${string}`;
      const [available, rawDecimals] = await Promise.all([
        readContractSafe<bigint>(client, {
          address: usdcAddress,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        }).catch(() => 0n),
        readContractSafe<number | bigint>(client, {
          address: usdcAddress,
          abi: ERC20_ABI,
          functionName: "decimals",
        }).catch(() => 6),
      ]);

      const decimals = Number(rawDecimals ?? 6);
      const now = Math.floor(Date.now() / 1000);
      let locked = 0n;
      let claimable = 0n;
      const entries: LockEntry[] = [];

      for (const market of uniqueMarkets) {
        const [lockedBalance, claimableBalance, lockEntries] =
          await Promise.all([
            readContractSafe<bigint>(client, {
              address: market.address,
              abi: LOCK_READ_ABI,
              functionName: "lockedBalance",
              args: [address],
            }).catch(async () => {
              return await readContractSafe<bigint>(client, {
                address: market.address,
                abi: LAUNCHPAD_MARKET_ABI,
                functionName: "lockedProceeds",
                args: [address],
              }).catch(() => 0n);
            }),
            readContractSafe<bigint>(client, {
              address: market.address,
              abi: LOCK_READ_ABI,
              functionName: "claimableBalance",
              args: [address],
            }).catch(() => 0n),
            readContractSafe<readonly [bigint[], bigint[]]>(client, {
              address: market.address,
              abi: LOCK_READ_ABI,
              functionName: "getLockEntries",
              args: [address],
            }).catch(() => null),
          ]);

        locked += lockedBalance;
        claimable += claimableBalance;

        if (lockEntries && Array.isArray(lockEntries[0])) {
          lockEntries[0].forEach((amount, index) => {
            const unlockTime = Number(lockEntries[1][index] ?? 0n);
            entries.push({
              amount,
              unlockTime,
              isClaimable: unlockTime <= now,
              timeRemaining: Math.max(0, unlockTime - now),
              marketAddress: market.address,
              marketName: market.name,
            });
          });
        }
      }

      entries.sort((a, b) => a.unlockTime - b.unlockTime);
      const nextEntry = entries.find((entry) => !entry.isClaimable);

      return {
        locked,
        claimable,
        available,
        pending: 0n,
        total: available + locked,
        vaultLocked: 0n,
        marketLocked: locked,
        decimals,
        nextUnlockAmount: nextEntry?.amount ?? 0n,
        nextUnlockTimestamp: nextEntry?.unlockTime ?? 0,
        entries,
      };
    },
  });

  const aggregated = lockQuery.data ?? {
    locked: 0n,
    claimable: 0n,
    available: 0n,
    pending: 0n,
    total: 0n,
    vaultLocked: 0n,
    marketLocked: 0n,
    decimals: 6,
    nextUnlockAmount: 0n,
    nextUnlockTimestamp: 0,
    entries: [],
  };

  const claim = useCallback(async () => {
    console.info("No global claim action is available in V12 from this hook.");
  }, []);

  const formatUSD = (value: bigint) => {
    const num = parseFloat(formatUnits(value, aggregated.decimals));
    return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
  };

  const lockedFormatted = formatUSD(aggregated.locked);
  const claimableFormatted = formatUSD(aggregated.claimable);
  const availableFormatted = formatUSD(aggregated.available);
  const pendingFormatted = formatUSD(aggregated.pending);
  const totalFormatted = formatUSD(aggregated.total);
  const nextUnlockFormatted = formatUSD(aggregated.nextUnlockAmount);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const secondsRemaining = Math.max(
    0,
    aggregated.nextUnlockTimestamp - nowSeconds,
  );
  const timeRemaining =
    secondsRemaining <= 0
      ? "Ready"
      : `${Math.floor(secondsRemaining / 3600)}h ${Math.floor((secondsRemaining % 3600) / 60)}m`;

  const refetch = useCallback(() => {
    void lockQuery.refetch();
  }, [lockQuery]);

  return useMemo(
    () => ({
      ...aggregated,
      lockedFormatted,
      claimableFormatted,
      availableFormatted,
      pendingFormatted,
      totalFormatted,
      nextUnlockFormatted,
      timeRemaining,
      isLoading: marketsLoading || lockQuery.isLoading,
      isClaiming: false,
      hasClaimable: aggregated.claimable > 0n,
      claim,
      refetch,
    }),
    [
      aggregated,
      lockedFormatted,
      claimableFormatted,
      availableFormatted,
      pendingFormatted,
      totalFormatted,
      nextUnlockFormatted,
      timeRemaining,
      marketsLoading,
      lockQuery.isLoading,
      claim,
      refetch,
    ],
  );
}
