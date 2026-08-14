// No instruction may straddle the two venues.
//
// The AMM trades in one token and the book in another, so every instruction
// that touches money belongs to exactly one of them. Getting a single line
// wrong — the AMM's mint constant beside the book's vault, say — mixes
// currencies, and it does so SILENTLY: the constraint still compiles, the
// account still exists, and the failure only appears when a real transfer
// moves the wrong token or a solvency check reads the wrong pot.
//
// There are ~30 such lines across 15 instructions. Reviewing them once proves
// nothing about the next edit, so the invariant is asserted from the source
// itself: for each instruction, collect every venue-bearing symbol it mentions
// — `AMM_TOKEN_MINT` / `BOOK_TOKEN_MINT`, `market.vault_amm` /
// `market.vault_book`, `fee_pool_amm` / `fee_pool_book` — and require they all
// name the same venue.
//
// Two instructions legitimately mention both because they CREATE both, and
// they are named here rather than pattern-matched, so adding a third
// mixed-venue instruction is a decision someone has to make explicitly.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const INSTRUCTIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../programs-core/programs/sooth-core/src/instructions",
);

/** Creates — or destroys — both venues' accounts, so it names both by design.
 *  `close_market` is the teardown mirror of `create_market`: it must pin and
 *  verify every vault and fee pool on both sides before reclaiming them. */
const BUILDS_BOTH = new Set([
  "create_market",
  "init_market_fee_pool",
  "close_market",
  // One burn claims yield from BOTH venues' vaults — paying one and burning
  // would forfeit the holder's share of the other, so the mixing is the
  // feature, not a slip.
  "redeem_lp",
]);

type Venue = "amm" | "book";

/** Every venue-bearing symbol in a source file, mapped to the venue it names. */
function venuesIn(source: string): { venue: Venue; symbol: string }[] {
  const found: { venue: Venue; symbol: string }[] = [];
  const patterns: [RegExp, Venue][] = [
    [/\bAMM_TOKEN_MINT\b/g, "amm"],
    [/\bBOOK_TOKEN_MINT\b/g, "book"],
    [/market\.vault_amm\b/g, "amm"],
    [/market\.vault_book\b/g, "book"],
    [/b"fee_pool_amm"/g, "amm"],
    [/b"fee_pool_book"/g, "book"],
  ];
  for (const [re, venue] of patterns) {
    for (const m of source.matchAll(re)) found.push({ venue, symbol: m[0] });
  }
  return found;
}

describe("venue separation", () => {
  const files = readdirSync(INSTRUCTIONS_DIR)
    .filter((f) => f.endsWith(".rs") && f !== "mod.rs")
    .sort();

  it("finds the instruction sources", () => {
    // A path that silently matches nothing would make every assertion below
    // vacuous — the exact failure mode this file exists to prevent elsewhere.
    expect(files.length).toBeGreaterThan(20);
  });

  it("no instruction mixes the two venues", () => {
    const mixed: string[] = [];
    for (const file of files) {
      const name = file.replace(/\.rs$/, "");
      if (BUILDS_BOTH.has(name)) continue;
      const hits = venuesIn(readFileSync(join(INSTRUCTIONS_DIR, file), "utf8"));
      const venues = new Set(hits.map((h) => h.venue));
      if (venues.size > 1) {
        mixed.push(
          `${name}: ${hits.map((h) => `${h.symbol}(${h.venue})`).join(", ")}`,
        );
      }
    }
    expect(mixed).toEqual([]);
  });

  it("the both-venue exemptions really do name both", () => {
    // Otherwise the allowlist would keep silencing an instruction long after
    // it stopped needing the exemption.
    for (const name of BUILDS_BOTH) {
      const hits = venuesIn(
        readFileSync(join(INSTRUCTIONS_DIR, `${name}.rs`), "utf8"),
      );
      const venues = new Set(hits.map((h) => h.venue));
      expect(venues, `${name} no longer names both venues`).toEqual(
        new Set(["amm", "book"]),
      );
    }
  });

  it("the single-token constant is gone", () => {
    // `BASE_TOKEN_MINT` meant "the one token". Any surviving use is a line the
    // split missed, and it would compile only if someone re-added the alias.
    const stragglers = files.filter((f) =>
      readFileSync(join(INSTRUCTIONS_DIR, f), "utf8").includes(
        "BASE_TOKEN_MINT",
      ),
    );
    expect(stragglers).toEqual([]);
  });
});
