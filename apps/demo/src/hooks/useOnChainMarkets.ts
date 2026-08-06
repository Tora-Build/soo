import { useChainStore } from "../store/useChainStore";
import { useDeployments } from "./useDeployments";
import { ABIS } from "../config/abis";
import { useDirectRead, readContractSafe } from "./useDirectRead";
import { DEFAULT_CHAIN_ID } from "../lib/chains";
import { getPollingInterval } from "../lib/polling";
import { parseSQFSafe, type SQFRule } from "../lib/sqf";
import { shortenAddress } from "../utils/format";

type Address = `0x${string}`;

export interface OnChainMarket {
  address: Address;
  name: string;
  symbol: string;
  creator: Address;
  lpToken: Address;
  isGraduated: boolean;
  isSettled: boolean;
  isFinalized: boolean;
  isDismissed: boolean;
  winningOutcome: number | null; // 0=NO, 1=YES, 2=INVALID, null=not settled
  createdAt: bigint;
  bBase: bigint;
  bCurrent: bigint;
  creatorDeposit: bigint;
  deadline?: number;
  trialEndTime?: number; // unix seconds; undefined = no trial data
  stage: "bonding" | "live" | "settled" | "finalized" | "dismissed" | "expired";
  // Parsed SQF fields (populated from name)
  question: string; // extracted from §question or raw name
  event?: string; // from §event
  category?: string; // from §category
  ruleDescription?: string; // from §rule description
  rule?: SQFRule; // full parsed §rule object (source, params, op, target, etc.)
  metaPicture?: string; // from §meta picture:url
  meta?: Record<string, string>; // full parsed §meta object
}

/**
 * Hook to fetch all markets from LaunchpadEngine on-chain
 *
 * This replaces the static markets.json config with dynamic on-chain discovery.
 * Markets are fetched from LaunchpadEngine.getMarkets() and enriched with
 * metadata from the markets mapping.
 */
export function useOnChainMarkets() {
  const { selectedChainId } = useChainStore();
  const parsedChainId =
    typeof selectedChainId === "number"
      ? selectedChainId
      : Number(selectedChainId);
  const chainId = Number.isFinite(parsedChainId)
    ? parsedChainId
    : DEFAULT_CHAIN_ID;
  const deployments = useDeployments();
  const launchpadEngineAddress = deployments?.contracts?.LaunchpadEngine as
    | Address
    | undefined;
  const startBlock = BigInt((deployments?.config as any)?.startBlock ?? 0);

  const query = useDirectRead({
    queryKey: ["v10", "onChainMarkets", chainId, launchpadEngineAddress],
    enabled: !!chainId && !!launchpadEngineAddress && !isNaN(chainId),
    chainId,
    refetchInterval: getPollingInterval(chainId, "normal"),
    staleTime: 15_000,
    read: async (client) => {
      if (!launchpadEngineAddress) return [];

      // Get all market addresses
      const marketAddresses = await readContractSafe<readonly Address[]>(
        client,
        {
          address: launchpadEngineAddress,
          abi: ABIS.LaunchpadEngine,
          functionName: "getMarkets",
        },
      ).catch((err) => {
        console.error("Failed to fetch market addresses:", err);
        return [] as readonly Address[];
      });

      if (!marketAddresses || marketAddresses.length === 0) {
        return [];
      }

      // Fetch market questions from the indexer (1 HTTP call) instead of
      // scanning event logs (which hits RPC block-range limits on HyperEVM).
      // Falls back to empty map if indexer is unavailable — markets will
      // show address-based symbols until the next refetch.
      const indexerMarketMap = new Map<
        string,
        { name?: string; createdAt?: bigint; deadline?: number }
      >();
      try {
        const indexerUrl =
          import.meta.env.VITE_INDEXER_URL ||
          "https://sooth-indexer.onrender.com";
        const resp = await fetch(`${indexerUrl}/launchpad-markets/${chainId}`);
        if (resp.ok) {
          const markets = (await resp.json()) as {
            address: string;
            name: string;
            createdAt?: string | number | null;
            deadline?: string | number | null;
          }[];
          for (const m of markets) {
            if (m.address) {
              const createdAt =
                typeof m.createdAt === "string" && /^\d+$/.test(m.createdAt)
                  ? BigInt(m.createdAt)
                  : typeof m.createdAt === "number" &&
                      Number.isFinite(m.createdAt)
                    ? BigInt(Math.floor(m.createdAt))
                    : 0n;
              const deadline =
                typeof m.deadline === "string" && /^\d+$/.test(m.deadline)
                  ? Number(m.deadline)
                  : typeof m.deadline === "number" &&
                      Number.isFinite(m.deadline)
                    ? m.deadline
                    : undefined;
              indexerMarketMap.set(m.address.toLowerCase(), {
                name: m.name,
                createdAt,
                deadline,
              });
            }
          }
        }
      } catch (e) {
        console.warn("[useOnChainMarkets] indexer fetch failed:", e);
      }

      // Process markets in chunks to avoid 429 rate limiting
      const CHUNK_SIZE = 20;
      const marketDetails: OnChainMarket[] = [];

      for (let i = 0; i < marketAddresses.length; i += CHUNK_SIZE) {
        const chunk = marketAddresses.slice(i, i + CHUNK_SIZE);

        const chunkResults = await Promise.all(
          chunk.map(async (marketAddress) => {
            try {
              const [marketsMapping, isGraduated, trialEndTimeRaw] =
                await Promise.all([
                  readContractSafe<
                    readonly [Address, Address, bigint, bigint, bigint]
                  >(client, {
                    address: launchpadEngineAddress!,
                    abi: ABIS.LaunchpadEngine,
                    functionName: "markets",
                    args: [marketAddress],
                  }),
                  readContractSafe<boolean>(client, {
                    address: launchpadEngineAddress!,
                    abi: ABIS.LaunchpadEngine,
                    functionName: "isGraduated",
                    args: [marketAddress],
                    // Falls back to `false`, but says so.
                    //
                    // This value decides `stage`, and `stage === "live"` is
                    // what opens a market on the ORDERBOOK rather than the
                    // AMM — so a swallowed failure sends a graduated market to
                    // the wrong panel and looks like it is still bonding.
                    //
                    // Letting the error propagate is worse: the enclosing
                    // handler returns `null` for the whole market, so the
                    // market vanishes from the list rather than merely opening
                    // on the wrong tab. Keep the fallback, lose the silence.
                  }).catch((e) => {
                    console.warn(
                      `[useOnChainMarkets] isGraduated failed for ${marketAddress} —` +
                        ` treating as bonding, so it will open on the AMM:`,
                      e,
                    );
                    return false;
                  }),
                  // Per-market trial deadline. Markets pre-trial-cap-change
                  // may have a larger stored value than the current
                  // defaultTrialPeriod — that's intentional (contract
                  // stores per-market, see knowledge.md Trial Period).
                  readContractSafe<bigint>(client, {
                    address: launchpadEngineAddress!,
                    abi: ABIS.LaunchpadEngine,
                    functionName: "trialEndTimes",
                    args: [marketAddress],
                  }).catch(() => 0n),
                ]);

              if (!marketsMapping) return null;

              const [creator, lpToken, bBase, creatorDeposit] = marketsMapping;

              const indexerMarket = indexerMarketMap.get(
                marketAddress.toLowerCase(),
              );
              const symbol = shortenAddress(marketAddress);

              // Fetch question, isSettled, isFinalized, and trial state in parallel
              let question = indexerMarket?.name || symbol;
              let isSettled = false;
              let isFinalized = false;
              const isDismissed = false; // dismiss removed in v0.1.2
              let winningOutcome: number | null = null;

              try {
                // Look up question from the pre-fetched batch map
                const questionFromLog = indexerMarket?.name ?? null;

                const [qHash, settled, winOutcome] = await Promise.all([
                  readContractSafe<string>(client, {
                    address: marketAddress as Address,
                    abi: ABIS.TruthMarket,
                    functionName: "questionHash",
                  }).catch(() => null),
                  readContractSafe<boolean>(client, {
                    address: marketAddress as Address,
                    abi: ABIS.TruthMarket,
                    functionName: "isSettled",
                  }).catch(() => false),
                  readContractSafe<number>(client, {
                    address: marketAddress as Address,
                    abi: ABIS.TruthMarket,
                    functionName: "winningOutcome",
                  }).catch(() => null),
                ]);

                if (questionFromLog) question = questionFromLog;
                // Drop the qHash truncation fallback — it rendered a
                // 0x-prefixed sliced hash that looked like a market address
                // and confused users on fresh markets where the staging
                // indexer hadn't backfilled yet (HE in particular at
                // ethGetLogsBlockRange:5). Leaving `question` as the
                // shortened address is the lesser evil; AMMPageBody can
                // render its own loading placeholder when name === symbol.
                isSettled = settled ?? false;
                isFinalized = isSettled;
                if (isSettled && winOutcome !== null) {
                  winningOutcome = Number(winOutcome);
                }
              } catch {}

              const sqf = parseSQFSafe(question);

              // Compute stage. Order matters:
              //   finalized > settled > live > expired > bonding
              // "expired" = trial ended without graduation. Pure UI
              // derivation from the contract's per-market trialEndTimes
              // and the graduation flag. Trading is still allowed via
              // the AMM; the badge is informational.
              const nowSec = BigInt(Math.floor(Date.now() / 1000));
              const trialEnded =
                (trialEndTimeRaw ?? 0n) > 0n &&
                nowSec >= (trialEndTimeRaw ?? 0n);
              let stage:
                | "bonding"
                | "live"
                | "settled"
                | "finalized"
                | "dismissed"
                | "expired";
              if (isDismissed) {
                stage = "dismissed";
              } else if (isFinalized) {
                stage = "finalized";
              } else if (isSettled) {
                stage = "settled";
              } else if (isGraduated) {
                stage = "live";
              } else if (trialEnded) {
                stage = "expired";
              } else {
                stage = "bonding";
              }

              return {
                address: marketAddress,
                name: question,
                symbol,
                creator,
                lpToken,
                isGraduated: isGraduated ?? false,
                isSettled,
                isFinalized,
                isDismissed,
                winningOutcome,
                createdAt: indexerMarket?.createdAt ?? 0n,
                deadline: indexerMarket?.deadline,
                trialEndTime: trialEndTimeRaw
                  ? Number(trialEndTimeRaw)
                  : undefined,
                bBase,
                bCurrent: bBase,
                creatorDeposit,
                stage,
                // Parsed SQF fields:
                question: sqf.question,
                event: sqf.event,
                category: sqf.category,
                ruleDescription: sqf.rule.description,
                rule: sqf.rule,
                metaPicture: sqf.meta?.picture,
                meta: sqf.meta,
              } as OnChainMarket;
            } catch {
              return null;
            }
          }),
        );

        // Add valid results from this chunk
        marketDetails.push(
          ...chunkResults.filter((m): m is OnChainMarket => m !== null),
        );

        // Small delay between chunks to be nice to the RPC
        if (i + CHUNK_SIZE < marketAddresses.length) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      return marketDetails;
    },
  });

  return {
    markets: query.data ?? [],
    marketCount: query.data?.length ?? 0,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * Hook to get just the market count (lighter weight)
 */
export function useOnChainMarketCount() {
  const { selectedChainId } = useChainStore();
  const chainId =
    typeof selectedChainId === "number"
      ? selectedChainId
      : Number(selectedChainId);
  const deployments = useDeployments();
  const launchpadEngineAddress = deployments?.contracts?.LaunchpadEngine as
    | Address
    | undefined;

  const query = useDirectRead({
    queryKey: ["v9", "onChainMarketCount", chainId, launchpadEngineAddress],
    enabled: !!chainId && !!launchpadEngineAddress,
    chainId,
    refetchInterval: getPollingInterval(chainId, "normal"),
    staleTime: 15_000,
    read: async (client) => {
      const count = await readContractSafe<bigint>(client, {
        address: launchpadEngineAddress!,
        abi: ABIS.LaunchpadEngine,
        functionName: "getMarketCount",
      });
      return Number(count);
    },
  });

  return {
    count: query.data ?? 0,
    isLoading: query.isLoading,
    error: query.error,
  };
}
