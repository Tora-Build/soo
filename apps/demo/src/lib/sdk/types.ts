// Chain-locked stub. Upstream's lib/sdk types are EVM-only; the Solana fork
// re-exports the structural names from the chain-shim so any incidental
// import compiles, then the call paths short-circuit at runtime.

export type {
  OutputLine,
  OutputLineType,
  OutputCallback,
  CommandResult,
  OrderType,
  OrderResult,
  Order,
  SpotSellOrder,
  MarketState,
  MarketInfo,
  Balances,
  InternalOutcomes,
} from "@/lib/chain-shim";

export { WAD, MAX_UINT256 } from "@/lib/chain-shim";

export interface SDKConfig {
  chainId: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walletClient?: any;
  contracts: Record<string, string | undefined>;
}

export interface SDKContext {
  config: SDKConfig;
  address?: string;
  marketKey?: string;
  marketAddress?: string;
}
