import { defineChain } from "@/lib/chain-shim";
import { Chain } from "@/lib/chain-shim";

// Chain type for hybrid support
export type ChainType = "evm" | "solana";

export interface AllowedChain {
  id: number | string;
  type: ChainType;
  name: string; // Real network name (for ChainSelector)
  displayName: string; // Branded name (for UI)
  shortName: string;
  rpcUrl: string;
  explorerUrl: string;
  icon: string; // emoji or URL
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
}

// Define chains using viem
export const baseSepolia = defineChain({
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.sooth.market/base-sepolia"] },
  },
  blockExplorers: {
    default: { name: "Basescan", url: "https://sepolia.basescan.org" },
  },
  contracts: {
    multicall3: {
      address: "0xca11bde05977b3631167028862be2a173976ca11",
      blockCreated: 5882,
    },
  },
  testnet: true,
});

export const ethSepolia = defineChain({
  id: 11155111,
  name: "Ethereum Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        "https://rpc.sooth.market/eth-sepolia",
        "https://ethereum-sepolia-rpc.publicnode.com",
      ],
    },
  },
  blockExplorers: {
    default: { name: "Etherscan", url: "https://sepolia.etherscan.io" },
  },
  contracts: {
    multicall3: {
      address: "0xca11bde05977b3631167028862be2a173976ca11",
      blockCreated: 5882,
    },
  },
  testnet: true,
});

export const bnbTestnet = defineChain({
  id: 97,
  name: "BNB Testnet",
  nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://data-seed-prebsc-1-s1.bnbchain.org:8545"] },
  },
  blockExplorers: {
    default: { name: "BscScan", url: "https://testnet.bscscan.com" },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
      blockCreated: 334,
    },
  },
  testnet: true,
});

// Define MegaETH Frontier using viem
export const megaethFrontier = defineChain({
  id: 4326,
  name: "MegaETH Frontier",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://mainnet.megaeth.com/rpc"] },
  },
  blockExplorers: {
    default: { name: "MegaExplorer", url: "https://explorer.megaeth.com" },
  },
  testnet: false, // It's "Mainnet" but Frontier phase
});

// Canonical list of allowed chains with metadata
export const allowedChains: AllowedChain[] = [
  {
    id: 11155111,
    type: "evm",
    name: "Ethereum Sepolia",
    displayName: "Eth Sepolia",
    shortName: "Sepolia",
    rpcUrl: "https://rpc.sooth.market/eth-sepolia",
    explorerUrl: "https://sepolia.etherscan.io",
    icon: "◇",
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
    },
  },
  {
    id: 6343,
    type: "evm",
    name: "MegaETH Testnet",
    displayName: "MegaETH",
    shortName: "Mega",
    rpcUrl: "https://rpc.sooth.market/megaeth-testnet",
    explorerUrl: "https://www.megaexplorer.xyz",
    icon: "⚡",
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
    },
  },
  // BNB Testnet - HIDDEN
  /*
  {
    id: 97,
    type: 'evm',
    name: 'BNB Testnet',
    displayName: 'BNB',
    shortName: 'BNB',
    rpcUrl: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
    explorerUrl: 'https://testnet.bscscan.com',
    icon: '🟡',
    nativeCurrency: {
      name: 'tBNB',
      symbol: 'tBNB',
      decimals: 18,
    },
  },
  */
  // MegaETH Frontier Net - HIDDEN (focusing on Base Sepolia and Monad)
  /*
  {
    id: 4326,
    type: 'evm',
    name: 'MegaETH Frontier',
    displayName: 'MegaETH',
    shortName: 'Mega',
    rpcUrl: 'https://mainnet.megaeth.com/rpc',
    explorerUrl: 'https://explorer.megaeth.com',
    icon: '⚡',
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
  },
  */
  // V11.1: Disabled - single-chain focus
  /*
   // Monad Testnet - RPCs: https://docs.monad.xyz/developer-essentials/testnets
   // Note: QuickNode/Foundation RPCs unreachable as of 2026-01
   {
     id: 10143,
     type: 'evm',
     name: 'Monad Testnet',
     displayName: 'Monad',
     shortName: 'Monad',
     rpcUrl: 'https://rpc.ankr.com/monad_testnet',
     explorerUrl: 'https://testnet.monadvision.com',
     icon: '🟣',
     nativeCurrency: {
       name: 'Monad',
       symbol: 'MON',
       decimals: 18,
     },
   },
   */
  // V11.1: Disabled - single-chain focus
  /*
   // MegaETH Testnet
   {
     id: 6343,
     type: 'evm',
     name: 'MegaETH Testnet',
     displayName: 'MegaETH',
     shortName: 'Mega',
     rpcUrl: 'https://carrot.megaeth.com/rpc',
     explorerUrl: 'https://megaeth-testnet-v2.blockscout.com',
     icon: '⚡',
     nativeCurrency: {
       name: 'Ether',
       symbol: 'ETH',
       decimals: 18,
     },
   },
   */
  // V11.1: Disabled - single-chain focus
  /*
   // Arc Testnet - Circle-backed chain with native USDC
   // Docs: https://docs.arc.network/arc/references/connect-to-arc
   {
     id: 5042002,
     type: 'evm',
     name: 'Arc Testnet',
     displayName: 'Arc',
     shortName: 'Arc',
     rpcUrl: 'https://rpc.testnet.arc.network',
     explorerUrl: 'https://testnet.arcscan.app',
     icon: '🔶',
     nativeCurrency: {
       name: 'USDC',
       symbol: 'USDC',
       decimals: 6,
     },
   },
   */
];

// Define MegaETH Testnet using viem
export const megaethTestnet = defineChain({
  id: 6343,
  name: "MegaETH Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        "https://rpc.sooth.market/megaeth-testnet",
        "https://carrot.megaeth.com/rpc",
      ],
    },
  },
  blockExplorers: {
    default: {
      name: "MegaExplorer",
      url: "https://www.megaexplorer.xyz",
    },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
      blockCreated: 334,
    },
  },
  testnet: true,
});

// Define Monad Testnet using viem
// RPCs: https://docs.monad.xyz/developer-essentials/testnets
// Note: QuickNode and Foundation RPCs are currently unreachable (2026-01)
export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        "https://rpc.ankr.com/monad_testnet", // Only reliable endpoint
      ],
    },
  },
  blockExplorers: {
    default: { name: "MonadVision", url: "https://testnet.monadvision.com" },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
      blockCreated: 334,
    },
  },
  testnet: true,
});

// Define Arc Testnet using viem
// Docs: https://docs.arc.network/arc/references/connect-to-arc
// Circle-backed chain with native USDC as gas token
// Note: Arc RPC doesn't support eth_newFilter/eth_getFilterChanges - use polling
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: {
      http: [
        "https://rpc.blockdaemon.testnet.arc.network",
        "https://rpc.drpc.testnet.arc.network",
        "https://rpc.testnet.arc.network",
        "https://rpc.quicknode.testnet.arc.network",
      ],
    },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  contracts: {
    multicall3: {
      address: "0xca11bde05977b3631167028862be2a173976ca11",
      blockCreated: 5882, // Placeholder
    },
  },
  testnet: true,
});

// HyperEVM Testnet — Hyperliquid's EVM layer
// Dual-block: small (2M gas, 1s) / big (30M gas, 60s)
// Faucet: https://chainstack.com/hyperliquid-faucet/
export const hyperevmTestnet = defineChain({
  id: 998,
  name: "HyperEVM Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.sooth.market/hyperevm-testnet"],
    },
  },
  blockExplorers: {
    default: { name: "Purrsec", url: "https://testnet.purrsec.com" },
  },
  testnet: true,
});

// EVM-only chains for wagmi
export const evmChains = allowedChains.filter((c) => c.type === "evm");

// Export wagmi chains array
export const wagmiChains: Chain[] = [
  ethSepolia,
  megaethTestnet,
];

// Helper to get chain by ID
export function getChainById(
  chainId: number | string,
): AllowedChain | undefined {
  return allowedChains.find((c) => c.id === chainId);
}

// Helper to check chain type
export function isEvmChain(chain: AllowedChain): boolean {
  return chain.type === "evm";
}

export function isSolanaChain(chain: AllowedChain): boolean {
  return chain.type === "solana";
}

// Default chain (MegaETH Testnet) — switched 2026-04-27 after seeding
// 70 markets on ME. Fresh users land on ME first; chain selector lets
// them switch to Eth Sepolia when needed.
export const DEFAULT_CHAIN_ID = 6343;

export function getExplorerUrl(chainId: number): string {
  const chain = getChainById(chainId);
  return chain?.explorerUrl || "https://sepolia.etherscan.io";
}

export function getAddressExplorerUrl(
  chainId: number,
  address: string,
): string {
  return `${getExplorerUrl(chainId)}/address/${address}`;
}

export function getTxExplorerUrl(chainId: number, txHash: string): string {
  return `${getExplorerUrl(chainId)}/tx/${txHash}`;
}

/**
 * Get recommended refetch interval for a chain
 * Different chains have different rate limits and block times
 */
export function getRefetchInterval(chainId: number): number {
  switch (chainId) {
    case 4326: // MegaETH Frontier - rate limited RPC
      return 8_000;
    case 10143: // Monad Testnet - rate limited (25 rps via QuickNode)
      return 5_000;
    case 5042002: // Arc Testnet - multiple RPC providers
      return 4_000;
    case 84532: // Base Sepolia - reliable public RPC
      return 4_000;
    case 11155111: // Eth Sepolia - reliable public RPC
      return 4_000;
    case 998: // HyperEVM Testnet - 1s small blocks
      return 4_000;
    default:
      return 5_000;
  }
}

/**
 * Get recommended stale time for a chain
 */
export function getStaleTime(chainId: number): number {
  switch (chainId) {
    case 4326: // MegaETH Frontier
      return 5_000;
    case 10143: // Monad Testnet
      return 3_000;
    case 5042002: // Arc Testnet
      return 2_000;
    case 84532: // Base Sepolia
      return 2_000;
    case 11155111: // Eth Sepolia
      return 2_000;
    case 998: // HyperEVM Testnet
      return 2_000;
    default:
      return 3_000;
  }
}
