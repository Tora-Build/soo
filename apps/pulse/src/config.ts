// Pulse configuration. Everything comes from env or the SDK's own defaults —
// there is deliberately no deployments.json, no chain registry, no shim.
import { PublicKey } from "@solana/web3.js";

const env = import.meta.env;

export const RPC_URL: string =
  env.VITE_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

export const PROGRAM_ID: string =
  env.VITE_SOOTH_CORE_ID ?? "EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw";
export const BOOK_MINT = new PublicKey(
  env.VITE_USDC_MINT ?? "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX",
);
export const AMM_MINT = new PublicKey(
  env.VITE_AMM_MINT ?? "CUsiEVc29hQa9xLBFB7nPQxP1aEiWq1cZkdfn8ATFHBu",
);

/** Display names for the venue tokens; role-stable, ticker-overridable. */
export const AMM_SYMBOL: string = env.VITE_AMM_TOKEN_SYMBOL ?? "EAST";
export const BOOK_SYMBOL: string = env.VITE_BOOK_TOKEN_SYMBOL ?? "USDC";

/** Seeded markets, comma-separated `sol:` refs. Created markets are added
 *  per-browser (localStorage) — same discovery model as the other surfaces,
 *  same limitation, same fix (an indexer) when it matters. */
export const SEED_MARKET_REFS: string[] = [
  env.VITE_DEMO_MARKET_REF,
  ...(env.VITE_DEMO_EXTRA_MARKET_REFS ?? "").split(","),
]
  .map((s: string | undefined) => (s ?? "").trim())
  .filter(Boolean)
  .map((s: string) => (s.startsWith("sol:") ? s : `sol:${s}`));

export const TEST_MODE = env.VITE_TEST_MODE === "true";
export const TEST_KEYPAIR_BYTES: string | undefined = env.VITE_TEST_KEYPAIR_BYTES;

export const WAD = 10n ** 18n;
