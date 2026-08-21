import { useCallback, useEffect, useMemo, useState } from "react";
import { yesPrice as tickYesPrice } from "../lib/book-view";
import { useAccount, usePublicClient } from "@/lib/chain-shim";
import { SOOTHBOOK_ABI } from "../config/abis";
import { encodePacked, formatUnits, keccak256 } from "@/lib/chain-shim";
import { useDeployments } from "./useDeployments";
import { useChainStore } from "../store/useChainStore";

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

          // One axis: the tick IS the YES price on BOTH sides, so no
          // complement is applied. Complementing the asks would render them at
          // 1 - p, landing them on top of the bids at the same price.
          const yesPriceValue = tickYesPrice(tick);
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

  const fetchOrderbook = useCallback(
    async (isBackground = false) => {
      // Why the ladder is empty, said out loud.
      //
      // This function has five paths that bail without rendering anything.
      // Each logs a reason, because a silent bail makes "no liquidity" look
      // identical whether the market has none, the market ref failed to
      // parse, or the RPC is unreachable.
      const bail = (why: string) => {
        // eslint-disable-next-line no-console
        console.warn(`[useOrderbook] no ladder: ${why}`, {
          marketAddress,
          marketKey,
        });
      };

      if (!soothBookAddress || !marketKey || !publicClient) {
        bail(
          !publicClient
            ? "no publicClient (wallet/provider not ready)"
            : !marketKey
              ? "no marketKey derived from marketAddress"
              : "no soothBookAddress in deployments",
        );
        return;
      }

      if (!isBackground) setIsLoading(true);
      try {
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
          bail("isMarketRegistered call failed");
          setIsSupported(false);
          return;
        }
        if (!(marketRes.result as boolean)) {
          bail("isMarketRegistered returned false — market ref did not resolve");
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

        if (bids.length === 0 && asks.length === 0) {
          bail("scan returned no levels on either side");
        }
        setOrderbook({ bids, asks });
        setLastUpdated(Date.now());
        setIsSupported(true);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "";
        bail(`threw: ${message.slice(0, 120)}`);
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
      marketAddress,
      marketKey,
      publicClient,
      scanTickDepth,
      soothBookAddress,
      userAddress,
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
