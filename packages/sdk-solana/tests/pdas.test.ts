// PDA seed and encoding goldens.
//
// A PDA helper can be wrong in two directions and neither fails loudly:
//
//   1. The SDK changes a seed or its byte encoding. Every derivation still
//      returns a valid-looking address, and the failure arrives at simulation
//      as a constraint violation naming an account nobody recognises. The
//      goldens below catch that.
//
//   2. The PROGRAM changes a seed. The goldens still pass — they only pin the
//      SDK against itself — so the seed literals are also checked against the
//      program source.
//
// The program id is pinned to a FIXED test value rather than the deployed one.
// A PDA is a function of (seeds, program id), so goldens built against the
// live id break on every redeploy, which is a deployment event and not a
// regression.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  deriveAdjudicatorEntryPda,
  deriveAmmStatePda,
  deriveFeePoolAuthorityPda,
  deriveLockAuthorityPda,
  deriveLockEntryPda,
  deriveLpMintAuthorityPda,
  deriveLpMintPda,
  deriveLpPositionPda,
  deriveLpYieldAuthority,
  deriveMarketPda,
  deriveMarketVaultAmm,
  derivePositionPda,
  deriveProtocolConfigPda,
  deriveVaultAuthorityPda,
  feePoolAmmPda,
  feePoolBookPda,
  lpYieldAmmPda,
  lpYieldBookPda,
} from "../src/pdas.js";
import { bookPda, eventAuthorityPda } from "../src/book/index.js";

/** Arbitrary and fixed. Never point this at the deployed program. */
const PROGRAM = {
  soothCore: new PublicKey("SoothTeSt1111111111111111111111111111111111"),
};

const MARKET_ID = Uint8Array.from([
  0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe, 0x01, 0x23, 0x45, 0x67,
  0x89, 0xab, 0xcd, 0xef,
]);
const USER = new PublicKey(Uint8Array.from(Array(32).fill(0x42)));
const MARKET_PDA = deriveMarketPda(MARKET_ID, PROGRAM)[0];
const POSITION_PDA = derivePositionPda(MARKET_ID, USER, PROGRAM)[0];

/** Every PDA the SDK derives, against the fixed program id above. */
const GOLDENS: Array<[string, string]> = [
  ["market", deriveMarketPda(MARKET_ID, PROGRAM)[0].toBase58()],
  ["amm_state", deriveAmmStatePda(MARKET_ID, PROGRAM)[0].toBase58()],
  ["vault_authority", deriveVaultAuthorityPda(MARKET_ID, PROGRAM)[0].toBase58()],
  ["lock_authority", deriveLockAuthorityPda(MARKET_ID, PROGRAM)[0].toBase58()],
  ["position", POSITION_PDA.toBase58()],
  ["vault_amm", deriveMarketVaultAmm(MARKET_ID, PROGRAM).toBase58()],
  ["lp_mint", deriveLpMintPda(MARKET_ID, PROGRAM)[0].toBase58()],
  ["lp_mint_authority", deriveLpMintAuthorityPda(MARKET_ID, PROGRAM)[0].toBase58()],
  ["lp_position", deriveLpPositionPda(MARKET_ID, USER, PROGRAM)[0].toBase58()],
  ["lp_yield_amm", lpYieldAmmPda(MARKET_ID, PROGRAM)[0].toBase58()],
  ["lp_yield_book", lpYieldBookPda(MARKET_ID, PROGRAM)[0].toBase58()],
  ["lp_yield_authority", deriveLpYieldAuthority(PROGRAM)[0].toBase58()],
  ["protocol_config", deriveProtocolConfigPda(PROGRAM)[0].toBase58()],
  ["fee_pool_authority", deriveFeePoolAuthorityPda(PROGRAM)[0].toBase58()],
  ["fee_pool_amm", feePoolAmmPda(MARKET_ID, PROGRAM)[0].toBase58()],
  ["fee_pool_book", feePoolBookPda(MARKET_ID, PROGRAM)[0].toBase58()],
  ["adjudicator", deriveAdjudicatorEntryPda(MARKET_PDA, PROGRAM)[0].toBase58()],
  ["lock_entry", deriveLockEntryPda(POSITION_PDA, 3n, PROGRAM)[0].toBase58()],
  ["book", bookPda(MARKET_ID, PROGRAM)[0].toBase58()],
  ["event_authority", eventAuthorityPda(PROGRAM)[0].toBase58()],
];

const EXPECTED: Record<string, string> = {
  market: "D1xa8g5UVnMivmd9otykcXd3dPYgCdpkivWfDiupitEp",
  amm_state: "FBttn7Sf2eznzbZZrA9cTY5wmXHbBaDcqY4arUHpNjYJ",
  vault_authority: "Gapvox8Y9icZAR5eszCDBHUM6Rqj9ahAE8dZWkiWNTwE",
  lock_authority: "EcsQ8X9hVQ7pj1dcYvoji9V3GkCrXTG3E4fQjDRiVSgQ",
  position: "8feaUeop293zSn5K9p3qq6Drfa8r5TFqctpdVkCV3yc4",
  vault_amm: "F4nb6Vh67WszjgBKLwNmvYv5Cs5z1VWVeDAsT6BHQSw1",
  lp_mint: "5UKvSoRdDpXH8s67EQe6587MiaaGaLJFqnRqLTQXxrGt",
  lp_mint_authority: "9X14myJ85esJWpZBXuYs8nHkBvgkZ8BWoVw5sCg7fncv",
  lp_position: "EosQFEvnPigBjLyfb3x4X63VGjVm4jntWMEHidT37ZMn",
  lp_yield_amm: "9Zkvy1BhQbnQq8iz4MnFo1FLpntSaBj8XQZTzM1G5Lzm",
  lp_yield_book: "3p66664M44FS9UZycGfzXaWgNtXmXbazDosc9tWEgENu",
  lp_yield_authority: "2N7yY9XjizYX7JyXPzZySszCJWvewmLHuuH1nywdqAdv",
  protocol_config: "AMtTuuWN8bMihxWcSdK9b96MWGMmvokQRTkUN4YX37MX",
  fee_pool_authority: "4LrYjVJueArVWvhVLD3bzapAkgUSDbudEesxgy45MsnT",
  fee_pool_amm: "GCxYYGJrmXwDMErE3pLiH5qHcAXQXM4AXWcB5UE1m7Di",
  fee_pool_book: "6k4tyMXRFP2DidUchqeWVLn4aYLXXiWqeGSuWSzPWCzn",
  adjudicator: "DLQyCUaS7JAVqjexyedFZCWfH1fK7kWg5E9YPmMFPuR",
  lock_entry: "7q6Fpxw1z3etjSz9FrSvYNCpTvLYW3N99gEPYiz2uki",
  book: "6x2Dqg3PTvmMzMEouARgevQV1SbtycLC5oUmRvCkcqV8",
  event_authority: "G5E3LgWcZsqopLagki1gExsao74ggZ2AH91jTRpB4roL",
};

/** Every seed literal `pdas.ts` and `book/index.ts` build addresses from. */
const SDK_SEEDS = [
  "market",
  "amm",
  "vault",
  "vault_amm",
  "lock",
  "lock_entry",
  "pos",
  "adjudicator",
  "protocol_config",
  "fee_pool_authority",
  "fee_pool_amm",
  "fee_pool_book",
  "lp",
  "lp_mint_authority",
  "lp_position",
  "lp_yield_authority",
  "lp_yield_amm",
  "lp_yield_book",
  "book",
];

const PROGRAM_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../programs-core/programs/sooth-core/src",
);

function readRustSources(dir: string): string {
  let out = "";
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out += readRustSources(path);
    else if (entry.endsWith(".rs")) out += readFileSync(path, "utf8");
  }
  return out;
}

describe("PDA derivation", () => {
  it("derives the addresses it has always derived", () => {
    expect(Object.fromEntries(GOLDENS)).toEqual(EXPECTED);
  });

  it("gives every PDA its own address", () => {
    // A duplicated or empty seed collapses two roles onto one account: the
    // second `init` then fails as "already in use" on an account whose name
    // says nothing about the collision.
    const addresses = GOLDENS.map(([, address]) => address);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it("encodes the lock nonce little-endian, distinctly per nonce", () => {
    // The nonce is `u64::to_le_bytes()` on the program side. Big-endian would
    // derive a valid address for every nonce and only ever collide at 0.
    const zero = deriveLockEntryPda(POSITION_PDA, 0n, PROGRAM)[0].toBase58();
    const one = deriveLockEntryPda(POSITION_PDA, 1n, PROGRAM)[0].toBase58();
    const swapped = deriveLockEntryPda(
      POSITION_PDA,
      0x0100_0000_0000_0000n,
      PROGRAM,
    )[0].toBase58();
    expect(one).not.toBe(zero);
    expect(one).not.toBe(swapped);
  });

  it("rejects a marketId that is not 16 bytes", () => {
    // Truncating or padding silently would derive a real address for the
    // wrong market.
    expect(() => deriveMarketPda(new Uint8Array(15), PROGRAM)).toThrow(
      /16 bytes/,
    );
    expect(() => deriveMarketPda(new Uint8Array(32), PROGRAM)).toThrow(
      /16 bytes/,
    );
  });

  it("uses only seeds the program itself derives", () => {
    // The goldens pin the SDK against itself. This pins it against the
    // program: a seed renamed on chain leaves the SDK deriving an address the
    // program will never accept, and the goldens would not notice.
    //
    // `__event_authority` is absent on purpose — Anchor's `#[event_cpi]` macro
    // emits it, so it never appears as a literal in the program source.
    const rust = readRustSources(PROGRAM_SRC);
    const missing = SDK_SEEDS.filter((seed) => !rust.includes(`b"${seed}"`));
    expect(missing, "seeds the program no longer derives").toEqual([]);
  });
});
