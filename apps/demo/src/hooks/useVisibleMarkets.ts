import { useMemo } from "react";
import { useNodeModeration } from "./useNodeModeration";
import { useOnChainMarkets } from "./useOnChainMarkets";

// Auto-hide test/spam markets. Observed patterns on Base 84532 (2026-04-27):
//   "e2e 84532 1777178132649"                            ×8 — lifecycle/orderbook spec auto-titles
//   "v02 E2E — Will this test pass? (1777115839020)"     ×8 — orderbook spec variant
//   "v0.2.0 smoke 1776917576"                            ×1 — smoke harness
//   "Will the E2E v0.2.0 lifecycle test pass on Base..." ×1 — self-referential
// Total: 18 of 97 markets matched. Doesn't replace useNodeModeration
// (registry-backed); complements it for frontends without operator-write
// permission and for spam volume too high to flag manually.
const E2E_QUESTION_PATTERNS: RegExp[] = [
  /^e2e\s+\d+\s+\d+/i, // "e2e <chainId> <timestamp>"
  /^e2e\s+\w+\s+\d+/i, // "e2e <method> <chainId>" variants
  /^v\d+(\.\d+)*\s+(e2e|smoke|test)\b/i, // "v02 E2E …", "v0.2.0 smoke …"
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
