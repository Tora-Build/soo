// Adjudicator reputation, from state the app already polls.
//
// `useResolutionStates` keeps every known market's resolution state fresh on
// a 20s cadence; scoring is a pure fold over exactly those states
// (`@sooth/sdk-solana`'s reputation module), so this hook costs zero
// additional RPC — the trust signal is a projection, not a fetch.

import { useMemo } from "react";
import {
  scoreAdjudicators,
  type AdjudicatorScore,
} from "@sooth/sdk-solana";

import { useResolutionStates, normalizeMarketKey } from "./useResolutionStates";

/** Every scored authority, keyed by base58 pubkey. */
export function useAdjudicatorScores(): {
  byAuthority: Map<string, AdjudicatorScore>;
  hasLoaded: boolean;
} {
  const { byMarket, proposalsByMarket, hasLoaded } = useResolutionStates();
  const byAuthority = useMemo(
    () =>
      scoreAdjudicators(
        Object.values(byMarket),
        Math.floor(Date.now() / 1000),
        Object.values(proposalsByMarket).map((p) => ({
          ...p,
          proposedAt: Number(p.proposedAt),
        })),
      ),
    [byMarket, proposalsByMarket],
  );
  return { byAuthority, hasLoaded };
}

/**
 * One authority's score, or null while unknown.
 *
 * Accepts any address form the app uses (`0x<base58>`, `sol:<base58>`, bare).
 * An authority with no history returns null rather than a fabricated blank
 * score — "no record" is information the caller should render as such.
 */
export function useAdjudicatorScore(
  authority: string | null | undefined,
): AdjudicatorScore | null {
  const { byAuthority } = useAdjudicatorScores();
  if (!authority) return null;
  const key = normalizeMarketKey(authority);
  return (key && byAuthority.get(key)) || null;
}
