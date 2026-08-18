// Demo runtime config. Hard-coded for the Solana-only fork; there is no
// per-deployment .env generation step. When pointing the demo at a real
// cluster, override `VITE_SOLANA_RPC_URL` and `VITE_USDC_MINT`.
//
// `pnpm dev` (no flag) targets devnet by default, so the program IDs below
// are the canonical devnet program IDs (mirrored from the Anchor IDLs which
// in turn mirror `sooth_protocol_types::ids`). `pnpm dev:localnet` opts into
// a local validator + the localnet seed flow which writes its own
// `.env.local` overrides on top.

import { type SoothNode, soothCoreIdl } from "@sooth/sdk-solana";

const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";
const USDC_MINT_DEVNET = "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX";
// The AMM's token. Distinct from the book's on purpose: the AMM prices in the
// instance token chosen at deploy, the book in USDC. Must match
// `AMM_TOKEN_MINT` in the program's `constants.rs` and the SDK's default.
const AMM_MINT_DEVNET = "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX";

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
  /**
   * WebSocket endpoint for `confirmTransaction`'s `signatureSubscribe`.
   *
   * `<ConnectionProvider>` derives this from `rpcUrl` by swapping the scheme
   * when no override is given, which is right for a validator and wrong for a
   * provider that serves RPC but not subscriptions. Alchemy's devnet endpoint
   * answers `getAccountInfo` fine and returns `-32601 Method not found` for
   * anything subscription-based on this key — every confirm then retries a
   * subscribe that can never succeed, and every write hangs at "confirming".
   *
   * Always the public endpoint's WS, regardless of which HTTP provider is
   * configured: confirms are the only thing this carries, so the public
   * endpoint's stricter rate limit is not a concern here the way it is for
   * reads.
   */
  wsUrl: string;
}

const env = ((
  import.meta as unknown as { env?: Record<string, string | undefined> }
).env ?? {}) as Record<string, string | undefined>;

/**
 * The WS endpoint to pair with `rpcUrl`. See `DemoConfig.wsUrl`.
 *
 * `VITE_SOLANA_WS_URL` wins outright. Otherwise: a local validator derives
 * its own ws port correctly by scheme-swapping, so leave those alone; any
 * other HTTP endpoint — devnet direct or a keyed provider — gets the public
 * devnet subscription endpoint, since that is the one guaranteed to answer
 * `signatureSubscribe`.
 */
function resolveWsUrl(rpcUrl: string): string {
  if (env?.VITE_SOLANA_WS_URL) return env.VITE_SOLANA_WS_URL;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(rpcUrl)) {
    return rpcUrl.replace(/^http/, "ws");
  }
  return "wss://api.devnet.solana.com/";
}

const rpcUrl = env?.VITE_SOLANA_RPC_URL ?? DEFAULT_DEVNET_RPC;

/**
 * Display names for the two venue tokens.
 *
 * The AMM's token is chosen per deployment, so its name cannot be a constant
 * in shared code — this deployment's is EAST, the next one's will not be.
 * `VITE_AMM_TOKEN_LABEL` overrides it without a code change; the ROLE ("AMM
 * venue") stays on screen beside the name, so a stale label degrades to
 * cosmetic rather than misleading someone about which venue they are funding.
 */
export const tokenLabels = {
  amm: env?.VITE_AMM_TOKEN_LABEL ?? "Mock EAST",
  book: env?.VITE_BOOK_TOKEN_LABEL ?? "Mock USDC",
} as const;

/**
 * Short tickers for inline amounts, where the full label is too long.
 *
 * The book's is rendered as a leading `$` by convention — it is USDC on every
 * deployment, and a prediction market quoted in dollars reads naturally. The
 * AMM's cannot be: its token is not a dollar and not even the same token twice
 * across deployments, so its amounts carry a trailing ticker instead.
 */
export const tokenSymbols = {
  amm: env?.VITE_AMM_TOKEN_SYMBOL ?? "USDC",
  book: env?.VITE_BOOK_TOKEN_SYMBOL ?? "USDC",
} as const;

export const demoConfig: DemoConfig = {
  wsUrl: resolveWsUrl(rpcUrl),
  node: {
    id: "solana-devnet",
    chainKind: "solana",
    chainId: "solana:devnet",
    cluster: "devnet",
    rpcUrl,
    programs: {
      // The adapter reads `soothCore` and `usdcMint` — nothing else. The
      // previous `soothAmm`/`soothMarket` keys were silently ignored after
      // the merge, which meant VITE_SOOTH_*_ID overrides did nothing and the
      // demo always fell back to the SDK's compiled-in default id.
      soothCore: env?.VITE_SOOTH_CORE_ID ?? SOOTH_CORE_ID,
      // `usdcMint` is the BOOK venue's token (the name predates the split and
      // is what the adapter still reads). `ammMint` is the AMM's.
      usdcMint: env?.VITE_USDC_MINT ?? USDC_MINT_DEVNET,
      ammMint: env?.VITE_AMM_MINT ?? AMM_MINT_DEVNET,
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
