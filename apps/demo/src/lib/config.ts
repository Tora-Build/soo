// Demo runtime config. Hardcoded for the Solana-only fork — the upstream's
// `scripts/sync-deployments.js` (per-deployment .env wiring) is intentionally
// dropped. When pointing the demo at a real cluster, override
// `VITE_SOLANA_RPC_URL` and `VITE_USDC_MINT`.
//
// The default `marketPda` is empty until a market exists on the active
// cluster. The smoke test creates a fresh market and injects its PDA via
// `setDemoMarket(...)`. In a deployed environment, this would be filled in
// by an indexer-driven market list — out of scope for this fork.

import type { SoothNode } from "@sooth/sdk-solana";

const DEFAULT_LOCALNET_RPC = "http://127.0.0.1:8899";

// Canonical devnet USDC mint, also the constant baked into the on-chain
// programs. The bankrun fixture writes a fresh mint at this address.
const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// Placeholder program IDs — these are the `declare_id!` constants from
// `programs/sooth_amm/src/lib.rs` and `programs/sooth_market/src/lib.rs`.
// They're what the .so binaries actually run at; deploy keypairs in
// `target/deploy/*.json` are unused for the binaries themselves.
const SOOTH_AMM_ID = "SoothAMM11111111111111111111111111111111111";
const SOOTH_MARKET_ID = "SoothMkt11111111111111111111111111111111111";

export interface DemoConfig {
  node: SoothNode;
  // Single market the demo points at. Real deployments would list-from-
  // indexer; this fork pins a single PDA for the buy-flow happy path.
  marketRef: string | null;
}

// Vite injects `import.meta.env` at build time. We read defensively because
// the test environment doesn't go through Vite — `vitest.config.ts` uses
// the React plugin but doesn't transform `import.meta.env` keys.
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
