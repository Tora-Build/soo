import { useCallback, useEffect, useMemo, useState } from "react";
import { tickToYesPrice } from "../lib/orderbook-math";
import { useAccount, usePublicClient } from "@/lib/chain-shim";
import { SOOTHBOOK_ABI } from "../config/abis";
import { encodePacked, formatUnits, keccak256 } from "@/lib/chain-shim";
import { useDeployments } from "./useDeployments";
import { useChainStore } from "../store/useChainStore";
import { fetchFromIndexer } from "./indexer/config";

interface IndexerOrder {
  side: number;
  tick: number;
  amount: string;
  filledAmount?: string;
  status: string;
}

export interface Order {
  id: string;
  maker: string;
  yesPrice: string;
  displayPrice: string;
  amount: string;
  timestamp: number;
  isBuySide: boolean;
  side: "bid" | "ask";
}

export interface OrderbookState {
  bids: Order[];
  asks: Order[];
}

export function useOrderbook(marketAddress: `0x${string}`) {
  const { address: userAddress } = useAccount();
  const { contracts } = useDeployments();
  // Source the chainId from the app's chain store so reads go to the chain
  // the user is browsing — not the wallet's current chain. Fall back to the
  // wagmi-default publicClient only if the store has no value.
  const { selectedChainId } = useChainStore();
  const storeChainId = Number(selectedChainId) || undefined;
  const publicClient = usePublicClient({ chainId: storeChainId });
  const soothBookAddress = contracts.SoothBook as `0x${string}` | undefined;

  const [orderbook, setOrderbook] = useState<OrderbookState>({
    bids: [],
    asks: [],
  });
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number>(0);
  const [isSupported, setIsSupported] = useState<boolean>(true);
  const [userYesShares, setUserYesShares] = useState(0);
  const [userNoShares, setUserNoShares] = useState(0);
  const [yesTokenAddress, setYesTokenAddress] = useState<
    `0x${string}` | undefined
  >(undefined);
  const [noTokenAddress, setNoTokenAddress] = useState<
    `0x${string}` | undefined
  >(undefined);

  const marketKey = useMemo(() => {
    return keccak256(encodePacked(["address"], [marketAddress]));
  }, [marketAddress]);

  const scanTickDepth = useCallback(
    async (side: 0 | 1, blockNumber: bigint): Promise<Order[]> => {
      if (!publicClient || !soothBookAddress || !marketKey) {
        return [];
      }

      const maxTickCalls = 999;
      const batchSize = 120;
      const ticks: number[] = [];
      for (let tick = 999; tick >= 1 && ticks.length < maxTickCalls; tick--) {
        ticks.push(tick);
      }
      const orders: Order[] = [];

      for (let start = 0; start < ticks.length; start += batchSize) {
        const batchTicks = ticks.slice(start, start + batchSize);
        const contracts = batchTicks.map((tick) => ({
          address: soothBookAddress,
          abi: SOOTHBOOK_ABI,
          functionName: "getOrdersAtTick" as const,
          args: [marketKey, side, tick] as const,
        }));
        const results = await publicClient.multicall({
          contracts,
          blockNumber,
        });

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const tick = batchTicks[i];
          if (!result || result.status !== "success") continue;

          const [totalAmount] = result.result as readonly [bigint, bigint];
          if (totalAmount <= 0n) continue;

          const yesPriceValue = tickToYesPrice(tick, side === 1 ? 1 : 0);
          const yesPrice = yesPriceValue.toFixed(4);

          orders.push({
            id: `${side}:${tick}`,
            maker: "aggregated",
            yesPrice,
            displayPrice: yesPrice,
            amount: formatUnits(totalAmount, 18),
            timestamp: 0,
            isBuySide: side === 1,
            side: side === 1 ? "bid" : "ask",
          });
        }
      }

      return orders;
    },
    [marketKey, publicClient, soothBookAddress],
  );

  /**
   * Fetch the orderbook depth from the Ponder indexer. Aggregates by
   * (side, tick), subtracting `filledAmount` from each order so the result
   * matches the on-chain `getOrdersAtTick` view (which returns the remaining
   * size, not the originally placed amount).
   *
   * Returns null if the indexer is unreachable — the caller falls back to
   * the RPC multicall scan.
   */
  const fetchFromIndexerDepth = useCallback(async (): Promise<{
    bids: Order[];
    asks: Order[];
  } | null> => {
    if (!storeChainId || !marketKey) return null;
    const orders = await fetchFromIndexer<IndexerOrder[]>(
      `/v12/orders/${storeChainId}/${marketKey}`,
    );
    if (orders === null) return null;

    const agg = new Map<
      string,
      { tick: number; total: bigint; side: number }
    >();
    for (const o of orders) {
      if (o.status !== "active") continue;
      const filled = BigInt(o.filledAmount ?? "0");
      const remaining = BigInt(o.amount) - filled;
      if (remaining <= 0n) continue;
      const key = `${o.side}:${o.tick}`;
      const existing = agg.get(key);
      if (existing) {
        existing.total += remaining;
      } else {
        agg.set(key, { tick: o.tick, total: remaining, side: o.side });
      }
    }

    const bids: Order[] = [];
    const asks: Order[] = [];
    for (const entry of agg.values()) {
      const yesPriceValue =
        tickToYesPrice(entry.tick, entry.side === 1 ? 1 : 0);
      const yesPrice = yesPriceValue.toFixed(4);
      const order: Order = {
        id: `${entry.side}:${entry.tick}`,
        maker: "aggregated",
        yesPrice,
        displayPrice: yesPrice,
        amount: formatUnits(entry.total, 18),
        timestamp: 0,
        isBuySide: entry.side === 1,
        side: entry.side === 1 ? "bid" : "ask",
      };
      if (entry.side === 1) bids.push(order);
      else asks.push(order);
    }
    bids.sort((a, b) => parseFloat(b.yesPrice) - parseFloat(a.yesPrice));
    asks.sort((a, b) => parseFloat(a.yesPrice) - parseFloat(b.yesPrice));
    return { bids, asks };
  }, [storeChainId, marketKey]);

  const fetchOrderbook = useCallback(
    async (isBackground = false) => {
      if (!soothBookAddress || !marketKey || !publicClient) return;

      if (!isBackground) setIsLoading(true);
      try {
        // Preferred path: indexer. On strict-cap chains (MegaETH/HyperEVM)
        // the RPC multicall of 999 getOrdersAtTick calls is slow and costly;
        // the indexer returns the same aggregated view in one request.
        const indexerDepth = await fetchFromIndexerDepth();
        if (indexerDepth !== null) {
          setOrderbook(indexerDepth);
          setLastUpdated(Date.now());
          setIsSupported(true);

          // Still fetch user balance from chain (indexer doesn't expose it
          // per-market in a single endpoint). Guard against chain errors.
          if (userAddress && marketKey) {
            try {
              const balRes = (await publicClient.readContract({
                address: soothBookAddress,
                abi: SOOTHBOOK_ABI,
                functionName: "getBalance",
                args: [marketKey, userAddress],
              })) as readonly [bigint, bigint];
              setUserYesShares(parseFloat(formatUnits(balRes[0], 18)));
              setUserNoShares(parseFloat(formatUnits(balRes[1], 18)));
            } catch {
              setUserYesShares(0);
              setUserNoShares(0);
            }
          } else {
            setUserYesShares(0);
            setUserNoShares(0);
          }
          return;
        }

        // Fallback: RPC multicall scan
        const snapshotBlock = await publicClient.getBlockNumber();

        const [marketRes] = await publicClient.multicall({
          contracts: [
            {
              address: soothBookAddress,
              abi: SOOTHBOOK_ABI,
              functionName: "isMarketRegistered" as const,
              args: [marketAddress] as const,
            },
          ],
          blockNumber: snapshotBlock,
        });

        if (marketRes.status !== "success") {
          setIsSupported(false);
          return;
        }
        if (!(marketRes.result as boolean)) {
          setIsSupported(false);
          return;
        }

        const [bids, asks] = await Promise.all([
          scanTickDepth(1, snapshotBlock),
          scanTickDepth(0, snapshotBlock),
        ]);

        if (userAddress && marketKey) {
          try {
            const balRes = (await publicClient.readContract({
              address: soothBookAddress,
              abi: SOOTHBOOK_ABI,
              functionName: "getBalance",
              args: [marketKey, userAddress],
              blockNumber: snapshotBlock,
            })) as readonly [bigint, bigint];
            setUserYesShares(parseFloat(formatUnits(balRes[0], 18)));
            setUserNoShares(parseFloat(formatUnits(balRes[1], 18)));
          } catch {
            setUserYesShares(0);
            setUserNoShares(0);
          }
        } else {
          setUserYesShares(0);
          setUserNoShares(0);
        }

        setOrderbook({ bids, asks });
        setLastUpdated(Date.now());
        setIsSupported(true);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "";
        if (
          message.includes("reverted") ||
          message.includes("function selector")
        ) {
          setIsSupported(false);
        }
      } finally {
        if (!isBackground) setIsLoading(false);
      }
    },
    [
      marketKey,
      publicClient,
      scanTickDepth,
      soothBookAddress,
      userAddress,
      fetchFromIndexerDepth,
    ],
  );

  useEffect(() => {
    fetchOrderbook(false);
  }, [fetchOrderbook]);

  useEffect(() => {
    const interval = setInterval(() => fetchOrderbook(true), 10000);
    return () => clearInterval(interval);
  }, [fetchOrderbook]);

  const getOrdersForOutcome = (outcome: 0 | 1) => {
    if (outcome === 0) {
      return { bids: orderbook.bids, asks: orderbook.asks };
    }

    return {
      bids: orderbook.asks.map((o) => ({
        ...o,
        displayPrice: (1 - parseFloat(o.yesPrice)).toFixed(4),
        side: "bid" as const,
      })),
      asks: orderbook.bids.map((o) => ({
        ...o,
        displayPrice: (1 - parseFloat(o.yesPrice)).toFixed(4),
        side: "ask" as const,
      })),
    };
  };

  return {
    orderbook,
    bids: orderbook.bids,
    asks: orderbook.asks,
    getOrdersForOutcome,
    isLoading,
    lastUpdated,
    isSupported,
    refetch: () => {
      fetchOrderbook();
    },
    userYesShares,
    userNoShares,
    yesTokenAddress,
    noTokenAddress,
  };
}
