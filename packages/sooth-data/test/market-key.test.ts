// marketKey is the identifier the demo and this service agree on. It is not
// security-relevant on its own, but a COLLISION is: two markets sharing a key
// means `resolveMarketAddress` serves one market's fills under the other's.
//
// main's implementation parsed a base58 string as hex, destroying ~64% of the
// input bytes before folding FNV-1a, then duplicated the first 128 bits into
// the last 128. These tests pin the replacement: the pubkey's own 32 bytes.

import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  deriveMarketKey,
  marketAddressFromKey,
  normalizeMarketKey,
} from "../src/market-key.js";

const MARKET = "7J6eKSPiYyxsvvCzUL2gG8DDZ9yZ1FiU2z1yvK6ykvFe";

describe("deriveMarketKey", () => {
  it("is the pubkey's own bytes as 0x-prefixed hex", () => {
    const key = deriveMarketKey(MARKET);
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(key.slice(2)).toBe(
      Buffer.from(new PublicKey(MARKET).toBytes()).toString("hex"),
    );
  });

  it("accepts a sol: prefixed ref", () => {
    expect(deriveMarketKey(`sol:${MARKET}`)).toBe(deriveMarketKey(MARKET));
  });

  it("round-trips through marketAddressFromKey", () => {
    expect(marketAddressFromKey(deriveMarketKey(MARKET))).toBe(MARKET);
  });

  it("rejects an address that is not a 32-byte pubkey", () => {
    // main's version happily produced a key for these, which could then never
    // match anything — a silent 404 rather than a clear error.
    expect(() => deriveMarketKey("not-a-pubkey")).toThrow(/not valid base58/);
    // Valid base58, wrong length (this is a 16-byte value).
    expect(() => deriveMarketKey("11111111111111111")).toThrow(/32 bytes/);
  });

  it("has no second-half mirroring", () => {
    // main emitted 0x${a}${b}${a}${b}, so bytes 0-15 always equalled 16-31.
    const hex = deriveMarketKey(MARKET).slice(2);
    expect(hex.slice(0, 32)).not.toBe(hex.slice(32));
  });

  it("is collision-free across many distinct markets", () => {
    // The property that matters. main's fold over hex-parsed base58 collapsed
    // so much entropy that this is exactly the risk it carried.
    const keys = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) {
      keys.add(deriveMarketKey(Keypair.generate().publicKey.toBase58()));
    }
    expect(keys.size).toBe(2_000);
  });

  it("normalizeMarketKey lowercases for case-insensitive lookup", () => {
    const key = deriveMarketKey(MARKET);
    expect(normalizeMarketKey(key.toUpperCase())).toBe(key);
  });
});

describe("marketAddressFromKey", () => {
  it("returns null for malformed keys", () => {
    expect(marketAddressFromKey("0xdeadbeef")).toBeNull();
    expect(marketAddressFromKey("nope")).toBeNull();
    expect(marketAddressFromKey(`0x${"z".repeat(64)}`)).toBeNull();
  });

  it("accepts keys with or without the 0x prefix", () => {
    const key = deriveMarketKey(MARKET);
    expect(marketAddressFromKey(key.slice(2))).toBe(MARKET);
  });
});
