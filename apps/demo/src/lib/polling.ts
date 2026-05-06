/**
 * Chain-aware polling intervals
 * 
 * Monad has strict rate limits (25 rps on QuickNode), so we need longer
 * polling intervals to avoid 429 errors.
 * 
 * Rate limits (from docs.monad.xyz):
 * - QuickNode: 25 rps
 * - Ankr: 300 req/10s (30 rps avg)
 * - Monad Foundation: 20 rps
 */

// Chain IDs
export const MONAD_TESTNET_CHAIN_ID = 10143;
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const MEGAETH_FRONTIER_CHAIN_ID = 4326;

// Polling interval multipliers by chain (relative to base)
const CHAIN_POLLING_MULTIPLIERS: Record<number, number> = {
  [BASE_SEPOLIA_CHAIN_ID]: 1,       // Base: normal polling
  [MEGAETH_FRONTIER_CHAIN_ID]: 1,   // MegaETH: normal polling
  [MONAD_TESTNET_CHAIN_ID]: 3,      // Monad: 3x slower (25 rps limit)
};

const BASE_INTERVALS = {
  FAST: 10000,
  NORMAL: 15000,
  SLOW: 30000,
  VERY_SLOW: 60000,
};

const JITTER_RATIO = 0.2;

export function addJitter(interval: number): number {
  const jitter = interval * JITTER_RATIO * Math.random();
  return Math.floor(interval + jitter);
}

export function getPollingInterval(
  chainId: number | undefined,
  speed: 'fast' | 'normal' | 'slow' | 'very_slow' = 'normal'
): number {
  const baseInterval = BASE_INTERVALS[speed.toUpperCase() as keyof typeof BASE_INTERVALS] || BASE_INTERVALS.NORMAL;
  const multiplier = chainId ? (CHAIN_POLLING_MULTIPLIERS[chainId] ?? 1) : 1;
  return addJitter(baseInterval * multiplier);
}

/**
 * Check if chain has rate limiting concerns
 */
export function isRateLimitedChain(chainId: number | undefined): boolean {
  return chainId === MONAD_TESTNET_CHAIN_ID;
}

/**
 * Default stale time (how long data is considered fresh)
 */
export function getStaleTime(chainId: number | undefined): number {
  // On rate-limited chains, keep data fresh longer
  return isRateLimitedChain(chainId) ? 30000 : 10000;
}

