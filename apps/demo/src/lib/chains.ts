export interface AllowedChain {
  id: number | string;
  name: string; // Real network name
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

// Canonical list of allowed chains with metadata.
//
// Numeric IDs follow the "Solana namespace" convention from
// `docs/decision-log.md` P3 (900-series) so the EVM-typed `id: number` slot in
// `AllowedChain` keeps round-tripping through wagmi-shaped hooks without adding
// string-typing.
//   900 = Solana Mainnet, 901 = Solana Devnet, 902 = Solana Localnet
export const allowedChains: AllowedChain[] = [
  {
    id: 902,
    name: "Solana Localnet",
    displayName: "Localnet",
    shortName: "Local",
    rpcUrl: "http://127.0.0.1:8899",
    explorerUrl: "https://explorer.solana.com",
    icon: "◎",
    nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 },
  },
  {
    id: 901,
    name: "Solana Devnet",
    displayName: "Devnet",
    shortName: "Devnet",
    rpcUrl: "https://api.devnet.solana.com",
    explorerUrl: "https://explorer.solana.com?cluster=devnet",
    icon: "◎",
    nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 },
  },
  {
    id: 900,
    name: "Solana Mainnet",
    displayName: "Mainnet",
    shortName: "Solana",
    rpcUrl: "https://api.mainnet-beta.solana.com",
    explorerUrl: "https://explorer.solana.com",
    icon: "◎",
    nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 },
  },
];

// Helper to get chain by ID
export function getChainById(
  chainId: number | string,
): AllowedChain | undefined {
  return allowedChains.find((c) => c.id === chainId);
}

// Default chain, resolved from the RPC the dapp is actually pointing at.
//   localnet → 902, devnet → 901, mainnet → 900
//
// The fallback MUST match `demoConfig.node.rpcUrl`'s fallback (config.ts uses
// devnet), and it must be a chain id deployments.json actually carries — only
// 901 and 902 are present. A fallback the two disagree on resolves every
// contract address to undefined, which silently disables every engine-gated
// hook: the AMM page mounts but no quote, liquidity or market-state read ever
// fires. Vitest sets no env, so the tests take this path.
const DEVNET_FALLBACK_CHAIN_ID = 901;

function defaultChainIdFromConfig(): number {
  const env = (
    import.meta as unknown as { env?: Record<string, string | undefined> }
  ).env;
  const rpc = env?.VITE_SOLANA_RPC_URL ?? "";
  if (rpc.startsWith("http://127.0.0.1") || rpc.startsWith("http://localhost"))
    return 902;
  if (rpc.includes("devnet")) return 901;
  if (rpc.includes("mainnet")) return 900;
  return DEVNET_FALLBACK_CHAIN_ID;
}

export const DEFAULT_CHAIN_ID = defaultChainIdFromConfig();

export function getExplorerUrl(chainId: number): string {
  const chain = getChainById(chainId);
  return chain?.explorerUrl || "https://explorer.solana.com";
}

export function getAddressExplorerUrl(
  chainId: number,
  address: string,
): string {
  return `${getExplorerUrl(chainId)}/address/${address}`;
}
