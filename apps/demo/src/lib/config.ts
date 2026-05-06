// Demo runtime config. Hard-coded for the Solana-only fork — upstream's
// `scripts/sync-deployments.js` (per-deployment .env wiring) is intentionally
// dropped. When pointing the demo at a real cluster, override
// `VITE_SOLANA_RPC_URL` and `VITE_USDC_MINT`.

import type { SoothNode } from "@sooth/sdk-solana";

const DEFAULT_LOCALNET_RPC = "http://127.0.0.1:8899";
const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOOTH_AMM_ID = "SoothAMM11111111111111111111111111111111111";
const SOOTH_MARKET_ID = "SoothMkt11111111111111111111111111111111111";

export interface DemoConfig {
  node: SoothNode;
  marketRef: string | null;
}

const env = ((
  import.meta as unknown as { env?: Record<string, string | undefined> }
).env ?? {}) as Record<string, string | undefined>;

export const demoConfig: DemoConfig = {
  node: {
    id: "solana-localnet",
    chainKind: "solana",
    chainId: "solana:localnet",
    cluster: "devnet",
    rpcUrl: env?.VITE_SOLANA_RPC_URL ?? DEFAULT_LOCALNET_RPC,
    programs: {
      soothAmm: env?.VITE_SOOTH_AMM_ID ?? SOOTH_AMM_ID,
      soothMarket: env?.VITE_SOOTH_MARKET_ID ?? SOOTH_MARKET_ID,
      usdcMint: env?.VITE_USDC_MINT ?? USDC_MINT_DEVNET,
    },
  },
  marketRef: env?.VITE_DEMO_MARKET_REF ?? null,
};
