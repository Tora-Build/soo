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

/** The pubkey literal `constants.rs` assigns to a `pubkey!(...)` constant. */
function constantMint(source: string, name: string): string {
  const re = new RegExp(
    `pub const ${name}\\s*:\\s*Pubkey\\s*=\\s*[\\s\\S]*?pubkey!\\(\\s*"([1-9A-HJ-NP-Za-km-z]+)"`,
  );
  const m = source.match(re);
  if (!m) throw new Error(`could not find ${name} in constants.rs`);
  return m[1];
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
    // Non-mainnet builds alias `AMM_TOKEN_MINT` to the devnet constant, which
    // is the one the SDK ships as its default.
    expect(defaultAdapter().ammMint.toBase58()).toBe(
      constantMint(source, "AMM_TOKEN_MINT_DEVNET"),
    );
  });

  it("the book default matches the devnet USDC mint", () => {
    expect(defaultAdapter().bookMint.toBase58()).toBe(
      constantMint(source, "USDC_MINT_DEVNET"),
    );
  });

  it("the two venues are different mints", () => {
    // The premise of the whole split. If a deployment ever set both to the
    // same token, every venue-separation guarantee would still "pass" while
    // meaning nothing.
    const a = defaultAdapter();
    expect(a.ammMint.equals(a.bookMint)).toBe(false);
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
