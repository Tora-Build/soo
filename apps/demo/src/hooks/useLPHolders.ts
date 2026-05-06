import { usePublicClient, useReadContracts } from "@/lib/chain-shim";
import { useMemo, useState, useEffect } from "react";
import { ERC20_ABI } from "../config/abis";
import { parseAbiItem, getAddress } from "@/lib/chain-shim";
import { getPollingInterval } from "../lib/polling";
import { useChainStore } from "../store/useChainStore";

export interface LPHolder {
  address: `0x${string}`;
  balance: bigint;
}

// Chains that reject wide `eth_getLogs` ranges. Chunk the Transfer scan into
// pieces that fit the cap; scan a bounded recent window so we don't fan out
// thousands of requests across months of chain history. See
// reference_getlogs_caps.md in memory for details.
const STRICT_GETLOGS_CHUNK: Record<number, bigint> = {
  6343: 9_999n, // MegaETH
  998: 999n, // HyperEVM
  10143: 500n, // Monad
};
// How far back to scan for Transfer events on any chain (in blocks).
// Base Sepolia etc accept the full range in one call; strict chains split it.
const LP_HOLDER_LOOKBACK = 40_000n;

/**
 * Hook to discover and fetch LP token holders for a Launchpad market
 * Uses Transfer events to find holders, then queries their current balances
 */
export function useLPHolders(
  marketAddress?: `0x${string}`,
  creatorAddress?: `0x${string}`,
) {
  // Read from the app-selected chain so the LP leaderboard matches the
  // market the user is browsing, not whatever chain the wallet is on.
  const { selectedChainId } = useChainStore();
  const chainId = Number(selectedChainId);
  const publicClient = usePublicClient({ chainId: chainId || undefined });
  const [holderAddresses, setHolderAddresses] = useState<`0x${string}`[]>([]);
  const [isLoadingEvents, setIsLoadingEvents] = useState(false);

  // Fetch Transfer events to discover LP holders
  useEffect(() => {
    if (!marketAddress || !publicClient) return;

    const fetchHolders = async () => {
      setIsLoadingEvents(true);
      try {
        const currentBlock = await publicClient.getBlockNumber();
        const lookbackStart =
          currentBlock > LP_HOLDER_LOOKBACK
            ? currentBlock - LP_HOLDER_LOOKBACK
            : 0n;
        const transferEvent = parseAbiItem(
          "event Transfer(address indexed from, address indexed to, uint256 value)",
        );

        // Build ranges — one shot for unrestricted chains, chunked
        // for strict-cap chains (MegaETH/HyperEVM/Monad) where a
        // single 40k-block query would return HTTP 400.
        const strictChunk = STRICT_GETLOGS_CHUNK[chainId];
        const ranges: Array<{ from: bigint; to: bigint }> = [];
        if (strictChunk) {
          let cursor = lookbackStart;
          while (cursor <= currentBlock) {
            const end = cursor + strictChunk - 1n;
            ranges.push({
              from: cursor,
              to: end > currentBlock ? currentBlock : end,
            });
            cursor = end + 1n;
          }
        } else {
          ranges.push({ from: lookbackStart, to: currentBlock });
        }

        const uniqueHolders = new Set<string>();
        if (creatorAddress) {
          uniqueHolders.add(creatorAddress.toLowerCase());
        }

        for (const range of ranges) {
          const logs = await publicClient.getLogs({
            address: marketAddress,
            event: transferEvent,
            fromBlock: range.from,
            toBlock: range.to,
          });
          for (const log of logs) {
            const to = log.args.to as string;
            if (to && to !== "0x0000000000000000000000000000000000000000") {
              uniqueHolders.add(to.toLowerCase());
            }
          }
        }

        setHolderAddresses(
          Array.from(uniqueHolders).map((addr) => getAddress(addr)),
        );
      } catch (error) {
        console.error("Error fetching LP holders:", error);
        // Fallback: at least show creator
        if (creatorAddress) {
          setHolderAddresses([getAddress(creatorAddress)]);
        }
      } finally {
        setIsLoadingEvents(false);
      }
    };

    fetchHolders();
  }, [marketAddress, publicClient, creatorAddress, chainId]);

  // Build contract calls to fetch balances
  const balanceContracts = useMemo(() => {
    if (!marketAddress || !holderAddresses.length) return [];
    return holderAddresses.map((addr) => ({
      address: marketAddress,
      abi: ERC20_ABI, // Use standard ERC20 for better compatibility
      functionName: "balanceOf" as const,
      args: [addr],
      chainId: chainId || undefined,
    }));
  }, [marketAddress, holderAddresses, chainId]);

  const {
    data: balanceData,
    isLoading: isLoadingBalances,
    refetch,
  } = useReadContracts({
    contracts: balanceContracts,
    query: {
      enabled: balanceContracts.length > 0,
      refetchInterval: getPollingInterval(chainId, "fast"),
    },
  });

  // Combine addresses with balances, filter out zero balances, sort by balance
  const holders: LPHolder[] = useMemo(() => {
    if (!balanceData) return [];

    return holderAddresses
      .map((addr, i) => ({
        address: addr,
        balance: (balanceData[i]?.result as bigint) || 0n,
      }))
      .filter((h) => h.balance > 0n)
      .sort((a, b) => (b.balance > a.balance ? 1 : -1)); // Descending by balance
  }, [holderAddresses, balanceData]);

  return {
    holders,
    isLoading: isLoadingEvents || isLoadingBalances,
    refetch,
  };
}
