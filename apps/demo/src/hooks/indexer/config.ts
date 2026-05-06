/**
 * Indexer configuration
 *
 * The indexer provides fast, indexed access to orderbook data.
 * Falls back to RPC if indexer is unavailable.
 */

// Default indexer URL (can be overridden via env)
export const INDEXER_URL =
  import.meta.env.VITE_INDEXER_URL || "http://localhost:42069";

// Whether to use indexer (enabled by default for development)
// Set VITE_USE_INDEXER=false to disable
export const USE_INDEXER = import.meta.env.VITE_USE_INDEXER !== "false";

// Timeout for indexer requests (ms)
export const INDEXER_TIMEOUT = 5000;

function parseStartBlockEnv(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const INDEXER_CHAIN_START_BLOCKS: Record<number, number> = {
  84532: parseStartBlockEnv(
    import.meta.env.VITE_INDEXER_START_BLOCK_BASE_SEPOLIA,
    39_474_167,
  ),
  10143: 6_558_931,
  5042002: 21_983_342,
  11155111: parseStartBlockEnv(
    import.meta.env.VITE_INDEXER_START_BLOCK_ETH_SEPOLIA,
    10_749_016,
  ),
  6343: parseStartBlockEnv(
    import.meta.env.VITE_INDEXER_START_BLOCK_MEGAETH_TESTNET,
    17_669_139,
  ),
  998: parseStartBlockEnv(
    import.meta.env.VITE_INDEXER_START_BLOCK_HYPEREVM_TESTNET,
    50_251_573,
  ),
};

// Cache for chain readiness status (avoids repeated /status calls)
const chainReadinessCache: Map<number, { ready: boolean; timestamp: number }> =
  new Map();
const CACHE_TTL = 10000; // 10 seconds

// Chain name mapping for status response. Ponder derives these from the
// chain name in registry.json and camelCases the result — `MegaETH Testnet`
// → `megaETHTestnet`, `HyperEVM Testnet` → `hyperEVMTestnet`. The keys here
// must match exactly or the readiness check silently reports "not indexed".
const CHAIN_NAME_MAP: Record<number, string> = {
  84532: "baseSepolia",
  11155111: "ethereumSepolia",
  10143: "monadTestnet",
  5042002: "arcTestnet",
  6343: "megaETHTestnet",
  998: "hyperEVMTestnet",
};

interface ChainStatus {
  id: number;
  block: {
    number: number;
    timestamp: number;
  };
}

interface IndexerStatus {
  [chainName: string]: ChainStatus;
}

/**
 * Check if indexer is ready for a specific chain
 * Returns true if the chain has synced past its start block
 */
export async function checkChainReady(chainId: number): Promise<boolean> {
  if (!USE_INDEXER) return false;

  // Check cache first
  const cached = chainReadinessCache.get(chainId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.ready;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INDEXER_TIMEOUT);

    const response = await fetch(`${INDEXER_URL}/status`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      chainReadinessCache.set(chainId, { ready: false, timestamp: Date.now() });
      return false;
    }

    const status: IndexerStatus = await response.json();
    const chainName = CHAIN_NAME_MAP[chainId];

    if (!chainName || !status[chainName]) {
      chainReadinessCache.set(chainId, { ready: false, timestamp: Date.now() });
      return false;
    }

    // Check if chain has indexed beyond start block (indicates sync progress)
    // We consider it "ready" if it has indexed at least 1000 blocks past start
    const chainStatus = status[chainName];
    const startBlock = INDEXER_CHAIN_START_BLOCKS[chainId] || 0;
    const isReady = chainStatus.block.number > startBlock + 1000;

    chainReadinessCache.set(chainId, { ready: isReady, timestamp: Date.now() });
    return isReady;
  } catch {
    chainReadinessCache.set(chainId, { ready: false, timestamp: Date.now() });
    return false;
  }
}

/**
 * Check if indexer is available (any chain ready)
 * @deprecated Use checkChainReady(chainId) for per-chain checks
 */
export async function checkIndexerHealth(): Promise<boolean> {
  if (!USE_INDEXER) return false;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INDEXER_TIMEOUT);

    const response = await fetch(`${INDEXER_URL}/ready`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch from indexer with timeout
 */
export async function fetchFromIndexer<T>(path: string): Promise<T | null> {
  if (!USE_INDEXER) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INDEXER_TIMEOUT);

    const response = await fetch(`${INDEXER_URL}${path}`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
