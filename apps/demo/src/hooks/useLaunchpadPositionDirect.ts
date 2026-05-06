import { useAccount } from "@/lib/chain-shim";
import { parseAbiItem } from "@/lib/chain-shim";
import { useChainStore } from "../store/useChainStore";
import { useDeployments } from "./useDeployments";
import { useDirectRead } from "./useDirectRead";

type Address = `0x${string}`;

const POSITION_TRADED_EVENT = parseAbiItem(
  "event PositionTraded(address indexed trader, address indexed market, int256 deltaShares, uint256 cost, uint256 fee)",
);

/**
 * User AMM position via LaunchpadEngine event-sourcing.
 *
 * Note: On current V8.1 deployments, AMMEngine positions are attributed to the
 * LaunchpadEngine (because it calls AMMEngine directly). To show per-wallet
 * positions in the UI, we sum PositionTraded deltas emitted by LaunchpadEngine.
 */
export function useLaunchpadPositionDirect(marketAddress: Address | undefined) {
  const { selectedChainId } = useChainStore();
  const chainId =
    typeof selectedChainId === "number"
      ? selectedChainId
      : Number(selectedChainId);
  const { address: userAddress } = useAccount();
  const deployments = useDeployments();
  const launchpadEngineAddress = deployments?.contracts?.LaunchpadEngine as
    | Address
    | undefined;

  const query = useDirectRead({
    queryKey: [
      "v8",
      "launchpadPositionDirect",
      chainId,
      launchpadEngineAddress,
      marketAddress,
      userAddress,
    ],
    enabled:
      !!chainId && !!launchpadEngineAddress && !!marketAddress && !!userAddress,
    chainId,
    read: async (client) => {
      try {
        const latest = await client.getBlockNumber();
        console.log(
          `[useLaunchpadPositionDirect] Scanning for ${marketAddress} user ${userAddress}. Latest: ${latest}`,
        );

        // Base Sepolia (and many others) limit getLogs to 100k block range.
        // We scan backwards in 100k chunks.
        const CHUNK_SIZE = 100_000n;
        const NUM_CHUNKS = 50; // Scan last 5M blocks (~115 days)

        let allLogs: any[] = [];
        let currentEnd = latest;

        for (let i = 0; i < NUM_CHUNKS; i++) {
          const fromBlock =
            currentEnd > CHUNK_SIZE ? currentEnd - CHUNK_SIZE : 0n;

          try {
            // Some RPCs struggle with topic filters in args. Fetch all for this contract & event, then filter in JS.
            const logs = await client.getLogs({
              address: launchpadEngineAddress!,
              event: POSITION_TRADED_EVENT,
              fromBlock,
              toBlock: currentEnd,
            });

            if (logs.length > 0) {
              const userLower = userAddress!.toLowerCase();
              const marketLower = marketAddress!.toLowerCase();

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const filtered = logs.filter(
                (l: any) =>
                  l.args.trader?.toLowerCase() === userLower &&
                  l.args.market?.toLowerCase() === marketLower,
              );

              if (filtered.length > 0) {
                console.log(
                  `[useLaunchpadPositionDirect] Chunk ${i}: Found ${filtered.length} matching logs (out of ${logs.length} total)`,
                );
                allLogs = [...allLogs, ...filtered];
              }
            }
          } catch (e) {
            console.warn(`[useLaunchpadPositionDirect] Chunk ${i} failed:`, e);
          }

          currentEnd = fromBlock - 1n;
          if (currentEnd <= 0n) break;
        }

        const shares = allLogs.reduce(
          (acc, l) => acc + BigInt(l.args.deltaShares),
          0n,
        );
        const yesShares = shares > 0n ? shares : 0n;
        const noShares = shares < 0n ? -shares : 0n;

        console.log(
          `[useLaunchpadPositionDirect] Final result: ${shares.toString()} shares (${allLogs.length} trades)`,
        );

        return {
          shares,
          yesShares,
          noShares,
          tradeCount: allLogs.length,
        };
      } catch (err) {
        console.error("[useLaunchpadPositionDirect] Fatal error:", err);
        return { shares: 0n, yesShares: 0n, noShares: 0n, tradeCount: 0 };
      }
    },
  });

  return {
    position: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
