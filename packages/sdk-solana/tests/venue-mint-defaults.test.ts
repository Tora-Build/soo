// The SDK's default venue mints must equal the program's compile-time ones.
//
// `SolanaChainAdapter` falls back to hardcoded mints when the node config does
// not name them, and the demo relies on that fallback — it constructs the
// adapter with only `node` and `connection`. Those literals are a copy of
// `AMM_TOKEN_MINT` / `BOOK_TOKEN_MINT` in `constants.rs`, and the program pins
// them with `address = ...` on `venue_mint`, so a drifted copy is not a
// display bug: every transaction the SDK builds is refused outright.
//
// The comment beside them already says the two sides must move together.
// A comment cannot fail CI, so this does.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Connection } from "@solana/web3.js";

import { SolanaChainAdapter } from "../src/adapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSTANTS = resolve(
  HERE,
  "../../programs-core/programs/sooth-core/src/constants.rs",
);

/** The pubkey `constants.rs` assigns to a constant — following one level of
 * `= OTHER_CONST;` aliasing, which is how a venue role points at a shared
 * mint (this deployment fills both roles with the mock USDC). */
function constantMint(source: string, name: string): string {
  const decl = new RegExp(
    `pub const ${name}\\s*:\\s*Pubkey\\s*=\\s*(?:anchor_lang::)?(?:pubkey!\\(\\s*"([1-9A-HJ-NP-Za-km-z]+)"|([A-Z_][A-Z0-9_]*)\\s*;)`,
  );
  const m = source.match(decl);
  if (!m) throw new Error(`could not find ${name} in constants.rs`);
  if (m[1]) return m[1];
  return constantMint(source, m[2]);
}

/** The adapter as the demo builds it: no mints supplied, defaults in play. */
function defaultAdapter(): SolanaChainAdapter {
  return new SolanaChainAdapter({
    node: {
      id: "venue-mint-defaults",
      chainKind: "solana",
      chainId: "test",
      rpcUrl: "http://127.0.0.1:8899",
    },
    connection: new Connection("http://127.0.0.1:8899"),
  } as never);
}

describe("venue mint defaults track the program", () => {
  const source = readFileSync(CONSTANTS, "utf8");

  it("the AMM default matches AMM_TOKEN_MINT", () => {
    // Non-mainnet builds alias `AMM_TOKEN_MINT` to the shared devnet mint;
    // constantMint follows the alias, which
    // is the one the SDK ships as its default.
    expect(defaultAdapter().ammMint.toBase58()).toBe(
      constantMint(source, "AMM_TOKEN_MINT"),
    );
  });

  it("the book default matches the devnet USDC mint", () => {
    expect(defaultAdapter().bookMint.toBase58()).toBe(
      constantMint(source, "USDC_MINT_DEVNET"),
    );
  });

  it("both venue roles are filled by the same mint", () => {
    // This deployment's choice: one mock USDC fills the AMM and book roles,
    // so users hold one balance and the UI runs one faucet. The roles stay
    // architecturally distinct — separate vaults, separate constraints — and
    // this pin makes the single-token choice a test failure to change
    // silently, in either direction.
    const a = defaultAdapter();
    expect(a.ammMint.equals(a.bookMint)).toBe(true);
  });

  it("mainnet has not silently inherited the devnet AMM token", () => {
    // `AMM_TOKEN_MINT` under `--features mainnet` is a `compile_error!` on
    // purpose, so shipping to mainnet requires someone to choose the token
    // rather than defaulting into the devnet mock. If that guard is ever
    // replaced with a real key, this test should be updated deliberately —
    // it fails loudly rather than letting the mock slip through.
    expect(source).toMatch(
      /#\[cfg\(feature = "mainnet"\)\][\s\S]{0,120}AMM_TOKEN_MINT\s*:\s*Pubkey\s*=\s*\n?\s*compile_error!/,
    );
  });
});
