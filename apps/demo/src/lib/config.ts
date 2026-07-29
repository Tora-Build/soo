// Demo runtime config. Hard-coded for the Solana-only fork — upstream's
// `scripts/sync-deployments.js` (per-deployment .env wiring) is intentionally
// dropped. When pointing the demo at a real cluster, override
// `VITE_SOLANA_RPC_URL` and `VITE_USDC_MINT`.
//
// `pnpm dev` (no flag) targets devnet by default, so the program IDs below
// are the canonical devnet program IDs (mirrored from the Anchor IDLs which
// in turn mirror `sooth_protocol_types::ids`). `pnpm dev:localnet` opts into
// a local validator + the localnet seed flow which writes its own
// `.env.local` overrides on top.

import { type SoothNode, soothAmmIdl, soothMarketIdl } from "@sooth/sdk-solana";

const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";
const USDC_MINT_DEVNET = "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX";
// Sourced from the IDL `address` fields, which in turn mirror each program's
// `declare_id!`. Keeps the config in lockstep with deploy keypair rotations
// without a second hand-pinned constant.
const SOOTH_AMM_ID = soothAmmIdl.address;
const SOOTH_MARKET_ID = soothMarketIdl.address;

export interface DemoConfig {
  node: SoothNode;
  marketRef: string | null;
}

const env = ((
  import.meta as unknown as { env?: Record<string, string | undefined> }
).env ?? {}) as Record<string, string | undefined>;

export const demoConfig: DemoConfig = {
  node: {
    id: "solana-devnet",
    chainKind: "solana",
    chainId: "solana:devnet",
    cluster: "devnet",
    rpcUrl: env?.VITE_SOLANA_RPC_URL ?? DEFAULT_DEVNET_RPC,
    programs: {
      soothAmm: env?.VITE_SOOTH_AMM_ID ?? SOOTH_AMM_ID,
      soothMarket: env?.VITE_SOOTH_MARKET_ID ?? SOOTH_MARKET_ID,
      usdcMint: env?.VITE_USDC_MINT ?? USDC_MINT_DEVNET,
    },
  },
  marketRef: env?.VITE_DEMO_MARKET_REF ?? null,
};
