import { useChainStore } from "../store/useChainStore";
import { ABIS } from "../config/abis";
import { useDirectRead, readContractSafe } from "./useDirectRead";

type Address = `0x${string}`;

export function useTruthMarketDirect(marketAddress: Address | undefined) {
  const { selectedChainId } = useChainStore();
  const chainId =
    typeof selectedChainId === "number"
      ? selectedChainId
      : Number(selectedChainId);

  const query = useDirectRead({
    queryKey: ["v8", "truthMarketDirect", chainId, marketAddress],
    enabled: !!marketAddress && !!chainId,
    chainId,
    read: async (client) => {
      // Each call individually swallows errors (returns null) so a single
      // missing function on a v0.1.2 minimal TruthMarket clone (e.g.
      // question(), guardian()) doesn't fail the whole hook.
      const safe = <T>(fn: string) =>
        readContractSafe<T>(client, {
          address: marketAddress!,
          abi: ABIS.TruthMarket,
          functionName: fn,
        }).catch(() => null as unknown as T);
      const results = await Promise.all([
        safe<boolean>("isLive"),
        safe<boolean>("isSettled"),
        safe<boolean>("isFinalized"),
        safe<number>("winningOutcome"),
        safe<bigint>("startTime"),
        safe<bigint>("deadline"),
        safe<Address>("creator"),
        safe<Address>("adjudicator"),
        safe<Address>("guardian"),
        safe<string>("question"),
        safe<bigint>("tStar"),
        safe<number>("state"),
      ]);

      const [
        isLive,
        isSettled,
        isFinalized,
        winningOutcome,
        startTime,
        deadline,
        creator,
        adjudicator,
        guardian,
        question,
        tStar,
        state,
      ] = results;

      const now = Math.floor(Date.now() / 1000);
      const startTimestamp = Number(startTime);
      const deadlineTimestamp = Number(deadline);
      let status: "live" | "settled" | "finalized" | "expired" | "pending";
      if (isFinalized) status = "finalized";
      else if (isSettled || state === 3) status = "settled";
      else if (now < startTimestamp) status = "pending";
      else if (now >= deadlineTimestamp) status = "expired";
      else if (isLive) status = "live";
      else status = "pending";

      const result = {
        address: marketAddress!,
        isLive,
        isSettled,
        isFinalized,
        winningOutcome,
        startTime: startTimestamp,
        deadline: deadlineTimestamp,
        creator,
        adjudicator,
        guardian,
        question,
        tStar: tStar ? Number(tStar) : undefined,
        state,
        status,
        timeRemaining: Math.max(0, deadlineTimestamp - now),
        isExpired: status === "expired",
        isPending: status === "pending",
        isVetoed: state === 4,
        hasWinner: isSettled && winningOutcome !== undefined,
      };

      return result;
    },
  });

  return {
    market: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
