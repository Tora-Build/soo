import {
  lookupMarketQuestion,
  rememberMarketQuestion,
} from "../lib/market-questions";
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
 * Markets are discovered on chain; there is no static market list.
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
                  // stores per-market).
                  readContractSafe<bigint>(client, {
                    address: launchpadEngineAddress!,
                    abi: ABIS.LaunchpadEngine,
                    functionName: "trialEndTimes",
                    args: [marketAddress],
                  }).catch(() => 0n),
                ]);

              if (!marketsMapping) return null;

              const [creator, lpToken, bBase, creatorDeposit] = marketsMapping;

              const symbol = shortenAddress(marketAddress);

              // Order matters. The local store covers markets this browser
              // created; `symbol` (a shortened address) is the last resort,
              // replaced below by the question read off the creation
              // transaction when one can be recovered.
              let question = lookupMarketQuestion(marketAddress) || symbol;

              // Still nameless? Recover it from the creation transaction —
              // the `MarketCreated` event is the only on-chain copy, and this
              // is what makes a market created on another device or by
              // another person show its actual question here.
              //
              // Cached into the same local store on the way through, because
              // the read walks the PDA's signature history and is far too
              // expensive to repeat on every poll.
              if (question === symbol) {
                const fromChain = await readContractSafe<string>(client, {
                  address: marketAddress as Address,
                  abi: ABIS.TruthMarket,
                  functionName: "marketQuestion",
                  args: [marketAddress],
                }).catch(() => "");
                if (fromChain && fromChain.trim()) {
                  question = fromChain;
                  rememberMarketQuestion(marketAddress, fromChain);
                }
              }
              let isSettled = false;
              let isFinalized = false;
              // `dismiss_market` is not read here; the moderation surface
              // owns market visibility.
              const isDismissed = false;
              let winningOutcome: number | null = null;

              let deadlineSec: number | undefined;
              try {
                const [settled, winOutcome, deadlineRaw] = await Promise.all([
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
                  // Every listing surface's deadline chip, "ending soon"
                  // sort and expiry filter hang off this one field — it was
                  // declared on OnChainMarket and never populated, so all
                  // three were dead code and an expired market swiped and
                  // sorted as live.
                  readContractSafe<bigint>(client, {
                    address: marketAddress as Address,
                    abi: ABIS.TruthMarket,
                    functionName: "deadline",
                  }).catch(() => null),
                ]);
                if (deadlineRaw !== null && deadlineRaw !== undefined && Number(deadlineRaw) > 0) {
                  deadlineSec = Number(deadlineRaw);
                }

                // A market whose question cannot be recovered keeps its
                // shortened address as the name; AMMPageBody renders its own
                // placeholder when name === symbol.
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
                createdAt: 0n,
                deadline: deadlineSec,
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
