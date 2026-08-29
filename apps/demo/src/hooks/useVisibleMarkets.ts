import { useMemo } from "react";
import { useNodeModeration } from "./useNodeModeration";
import { useOnChainMarkets } from "./useOnChainMarkets";

// Auto-hide markets whose question is an e2e or smoke-harness auto-title —
// "e2e <chainId> <timestamp>", "v02 E2E — …", "v0.2.0 smoke <timestamp>".
//
// Complements `useNodeModeration` (registry-backed) rather than replacing it:
// this covers frontends without operator-write permission, and spam volume
// too high to flag by hand.
const E2E_QUESTION_PATTERNS: RegExp[] = [
  /^e2e\s+\d+\s+\d+/i, // "e2e <chainId> <timestamp>"
  /^e2e\s+\w+\s+\d+/i, // "e2e <method> <chainId>" variants
  /^v\d+(\.\d+)*\s+(e2e|smoke|test)\b/i, // "v02 E2E …", "v0.2.0 smoke …"
  // Playwright fixtures stamp a run id into the question ("… run=1787388084").
  // These leaked into the explorer whenever the listing recovered the text.
  /\brun=\d{9,}/i,
];

// Sooth-core version marker, e.g. "v0.2.0" or "v02"
const VERSION_MARKER = /\bv\d+(\.\d+){0,2}\b/i;
// Test-suite markers
const TEST_MARKER = /\b(e2e|smoke|lifecycle test|test pass)\b/i;

function isE2ESpam(question: string | null | undefined): boolean {
  if (!question) return false;
  const q = question.trim();
  if (E2E_QUESTION_PATTERNS.some((re) => re.test(q))) return true;
  // Conjunction: any question mentioning BOTH a version marker AND a
  // test-suite marker is almost certainly auto-generated test data.
  return VERSION_MARKER.test(q) && TEST_MARKER.test(q);
}

export function useVisibleMarkets() {
  const marketQuery = useOnChainMarkets();
  const { hiddenMarketSet } = useNodeModeration();

  const visibleMarkets = useMemo(
    () =>
      marketQuery.markets.filter(
        (market) =>
          !hiddenMarketSet.has(market.address.toLowerCase()) &&
          !isE2ESpam(market.question),
      ),
    [hiddenMarketSet, marketQuery.markets],
  );

  return {
    ...marketQuery,
    markets: visibleMarkets,
    marketCount: visibleMarkets.length,
  };
}
