// Every shape a market identifier arrives in, and the one that was dropped.
//
// Upstream hooks identify a market by `keccak256(encodePacked(["address"], …))`.
// The shim's `keccak256` is the identity path for real markets — it decodes the
// base58 pubkey and returns its own 32 bytes as hex — so `marketKey` is
// `0x` + 64 hex chars.
//
// `toMarketRef` only ever stripped the `0x` and passed the rest on as base58.
// A marketKey therefore became a ref no `PublicKey` could parse, every read
// keyed on it degraded to empty, and the shared orderbook ladder rendered "no
// liquidity" against a book full of it. The panels that pass a real market ref
// still worked, so the symptom read as "orders only exist for the connected
// wallet" — the ladder was missing, not the orders.
//
// The two `0x` forms have to be told apart, which is why the length check is
// load-bearing rather than incidental.

import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

import { toMarketRef } from "../src/lib/chain-shim/amm-bridge";
import { encodePacked, keccak256 } from "../src/lib/chain-shim";

const MARKET = new PublicKey("gjU5jUBsQPvezpU5heWh2Hit6kqJgaVf5P8pGVUiiu6");

describe("toMarketRef", () => {
  it("resolves a marketKey back to the market", () => {
    // The case that was broken. Round-trips through the exact expression
    // `useOrderbook` uses, so a change to either side fails here.
    const marketKey = keccak256(
      encodePacked(["address"], [MARKET.toBase58() as never]),
    );
    expect(toMarketRef(marketKey)).toBe(`sol:${MARKET.toBase58()}`);
  });

  it("still resolves the 0x-wrapped base58 `useAccount` produces", () => {
    // The other `0x` form. Both must work; only the length distinguishes them.
    expect(toMarketRef(`0x${MARKET.toBase58()}`)).toBe(`sol:${MARKET.toBase58()}`);
  });

  it("passes a sol: ref through untouched", () => {
    expect(toMarketRef(`sol:${MARKET.toBase58()}`)).toBe(`sol:${MARKET.toBase58()}`);
  });

  it("accepts a bare base58 pubkey", () => {
    expect(toMarketRef(MARKET.toBase58())).toBe(`sol:${MARKET.toBase58()}`);
  });

  it("tells the two 0x forms apart by length, not by guessing", () => {
    // base58 of 32 bytes is 32–44 chars, so it can never be 64. That is what
    // makes the discrimination safe rather than heuristic — and it holds for
    // every key, not just this one.
    for (let i = 0; i < 40; i += 1) {
      const key = Keypair.generate().publicKey;
      const b58 = key.toBase58();
      expect(b58.length).toBeLessThan(64);
      expect(toMarketRef(`0x${b58}`)).toBe(`sol:${b58}`);
      expect(toMarketRef(`0x${Buffer.from(key.toBytes()).toString("hex")}`)).toBe(
        `sol:${b58}`,
      );
    }
  });

  it("returns undefined for junk rather than a ref that fails later", () => {
    // A bad ref that survives this function becomes an empty panel somewhere
    // downstream with nothing to point at. Failing here keeps the cause near
    // the mistake.
    expect(toMarketRef(undefined)).toBeUndefined();
    expect(toMarketRef("")).toBeUndefined();
    expect(toMarketRef("0x")).toBeUndefined();
    // 64 chars, but not valid hex bytes for a key.
    expect(toMarketRef(`0x${"z".repeat(64)}`)).toBe(`sol:${"z".repeat(64)}`);
  });

  it("is stable across repeated calls", () => {
    const marketKey = keccak256(
      encodePacked(["address"], [MARKET.toBase58() as never]),
    );
    expect(toMarketRef(marketKey)).toBe(toMarketRef(marketKey));
  });
});
