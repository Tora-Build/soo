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

import { type SoothNode, soothCoreIdl } from "@sooth/sdk-solana";

const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";
const USDC_MINT_DEVNET = "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX";
// Sourced from the IDL `address` field, which mirrors the program's
// `declare_id!`. Keeps the config in lockstep with deploy keypair rotations
// without a second hand-pinned constant.
//
// One program now, not five: the 5→1 merge folded sooth_amm, sooth_market,
// sooth_book, sooth_launchpad and sooth_adjudicator into sooth_core.
const SOOTH_CORE_ID = soothCoreIdl.address;

export interface DemoConfig {
  node: SoothNode;
  marketRef: string | null;
  extraMarketRefs: string[];
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
      // The adapter reads `soothCore` and `usdcMint` — nothing else. The
      // previous `soothAmm`/`soothMarket` keys were silently ignored after
      // the merge, which meant VITE_SOOTH_*_ID overrides did nothing and the
      // demo always fell back to the SDK's compiled-in default id.
      soothCore: env?.VITE_SOOTH_CORE_ID ?? SOOTH_CORE_ID,
      usdcMint: env?.VITE_USDC_MINT ?? USDC_MINT_DEVNET,
    },
  },
  marketRef: env?.VITE_DEMO_MARKET_REF ?? null,
  // Extra markets to list alongside the seeded one, comma-separated.
  //
  // The demo has no on-chain market registry — `getMarkets` is served from
  // this list — so without it exactly one market is ever visible, and any
  // market created outside the seed script is unreachable through the UI.
  extraMarketRefs: (env?.VITE_DEMO_EXTRA_MARKET_REFS ?? "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean)
    .map((s: string) => (s.startsWith("sol:") ? s : `sol:${s}`)),
};
