// Is this market graduated? Ask the program.
//
// ## Why this exists as its own read
//
// Whether a market shows the orderbook or the AMM is one on-chain fact:
// `AmmState.is_graduated`, which the program itself gates `book_place` on.
// Deriving it from a cached market list instead — through `useOnChainMarkets`,
// into a `stage` string, searched by address at click time — makes every hop
// a chance to answer "not graduated" for a reason that has nothing to do
// with the chain (list not loaded, market filtered out, an unrelated read
// failure dropping the entry, a swallowed error). All of those look identical
// to a user: a graduated market that opens on the AMM.
//
// So this asks the one question directly and answers in three states, not two.
// `undefined` means "not known yet" and must never be collapsed into `false` —
// that collapse would open a graduated market on the wrong panel while the
// answer is still in flight.

import { useQuery } from "@tanstack/react-query";

import { ABIS } from "../config/abis";
import { usePublicClient } from "@/lib/chain-shim";
import { useDeployments } from "./useDeployments";

/**
 * `true` graduated, `false` not, `undefined` not yet known.
 *
 * Callers must branch on all three. Treating `undefined` as `false` reproduces
 * the bug this replaces.
 */
export function useIsGraduated(
  marketAddress: string | null | undefined,
): boolean | undefined {
  const publicClient = usePublicClient();
  const { contracts } = useDeployments();
  const engine = contracts.LaunchpadEngine as `0x${string}` | undefined;

  const { data } = useQuery<boolean>({
    queryKey: ["is-graduated", marketAddress],
    enabled: !!marketAddress && !!publicClient && !!engine,
    // Graduation is one-way and rare, but it is also the thing a user is
    // waiting on when they graduate a market by trading, so this stays fresh
    // enough to flip the panel without a reload.
    staleTime: 5_000,
    refetchInterval: 15_000,
    queryFn: async () => {
      const result = await publicClient!.readContract({
        address: engine!,
        abi: ABIS.LaunchpadEngine,
        functionName: "isGraduated",
        args: [marketAddress!],
      });
      return Boolean(result);
    },
  });

  return data;
}
