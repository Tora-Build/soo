// The book layout constants are mirrored by hand from Rust into TypeScript.
//
// Nothing enforces that at compile time and nothing would fail loudly at
// runtime: a stale `BLOCK_SIZE` decodes the book into plausible nonsense, and a
// stale `MAX_ORDERS` makes the client refuse orders the program would accept
// (or the reverse). So the mirror is checked against the source of truth.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BLOCK_SIZE,
  BLOCKS_OFFSET,
  DISCRIMINATOR_LEN,
  HEADER_LEN,
  MAX_ORDERS,
  NIL,
} from "../src/book/index.js";

const ARENA = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../programs-core/programs/sooth-core/src/book/arena.rs",
);

/** `pub const NAME: type = VALUE;`, underscores stripped. */
function rustConst(source: string, name: string): number {
  const m = source.match(
    new RegExp(`pub const ${name}\\s*:\\s*\\w+\\s*=\\s*([0-9_]+)`),
  );
  if (!m) throw new Error(`${name} not found in arena.rs`);
  return Number(m[1]!.replace(/_/g, ""));
}

describe("book constants mirror the Rust", () => {
  const src = readFileSync(ARENA, "utf8");

  it("MAX_ORDERS matches", () => {
    expect(MAX_ORDERS).toBe(rustConst(src, "MAX_ORDERS"));
  });

  it("BLOCK_SIZE matches", () => {
    expect(BLOCK_SIZE).toBe(rustConst(src, "BLOCK_SIZE"));
  });

  it("NIL matches", () => {
    // Written as `u32::MAX` in Rust rather than a literal, so assert the value
    // it denotes.
    expect(src).toMatch(/pub const NIL: u32 = u32::MAX;/);
    expect(NIL).toBe(0xffffffff);
  });

  it("the header offset is the discriminator plus the header", () => {
    expect(BLOCKS_OFFSET).toBe(DISCRIMINATOR_LEN + HEADER_LEN);
  });
});
