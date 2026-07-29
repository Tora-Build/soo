// `marketKey` — the opaque 32-byte identifier the demo and this service use to
// refer to a market.
//
// Upstream (EVM) computes it as `keccak256(encodePacked(["address"], [market]))`
// because an EVM address is 20 bytes and needs widening. A Solana market
// address is ALREADY 32 bytes, so no hash is required: the pubkey's own bytes
// are the identifier. That makes the mapping a bijection — zero collisions, and
// invertible, which removes the need to resolve keys through a metadata table
// at all.
//
// ## Why not port main's version
//
// main's `deriveMarketKey` folded FNV-1a over `bytesFromHexLike("0x" + base58)`
// — and `bytesFromHexLike` parses a BASE58 string as hex. Only 21 of the 58
// base58 characters are hex-valid, and non-hex pairs become `parseInt(...) || 0`
// = zero, so roughly 64% of the input bytes were destroyed before hashing (the
// repo's own test vector reduced to 22 bytes of which 11 were zero). It then
// emitted `0x${a}${b}${a}${b}`, making the second 128 bits a literal copy of
// the first — 128 bits of nominal output carrying far less real entropy.
//
// It survived only because the market set was two hand-seeded entries. A
// collision would have made `resolveMarketAddress` serve one market's fills
// under another market's key.
//
// The demo's `keccak256` shim (apps/demo/src/lib/chain-shim/viem-shim.ts) is
// the other half of this contract and MUST agree byte for byte.

import { decodeBase58, encodeBase58 } from "./base58.js";
import type { Hex } from "./types.js";

const PUBKEY_BYTES = 32;

function toHex(bytes: Uint8Array): Hex {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return `0x${out}` as Hex;
}

/**
 * Derive the marketKey for a base58 Solana market address.
 *
 * Throws on anything that is not a 32-byte pubkey rather than silently
 * producing a lookup key that can never match — a bad address should fail at
 * the call site, not 404 mysteriously later.
 */
export function deriveMarketKey(marketBase58: string): Hex {
  const raw = marketBase58.startsWith("sol:")
    ? marketBase58.slice(4)
    : marketBase58;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase58(raw);
  } catch (cause) {
    throw new Error(
      `market address ${marketBase58} is not valid base58: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (bytes.length !== PUBKEY_BYTES) {
    throw new Error(
      `market address ${marketBase58} must decode to ${PUBKEY_BYTES} bytes, got ${bytes.length}`,
    );
  }
  return toHex(bytes);
}

/**
 * Inverse of `deriveMarketKey`: recover the base58 market address from a key.
 * Returns null if the input is not a 32-byte hex key.
 *
 * This is what lets any market resolve without appearing in
 * `data/market-meta.json` — main could only resolve the handful of markets
 * present in that hand-edited file.
 */
export function marketAddressFromKey(marketKey: string): string | null {
  const text = marketKey.startsWith("0x") ? marketKey.slice(2) : marketKey;
  if (text.length !== PUBKEY_BYTES * 2 || !/^[0-9a-fA-F]+$/.test(text)) {
    return null;
  }
  const bytes = new Uint8Array(PUBKEY_BYTES);
  for (let i = 0; i < PUBKEY_BYTES; i += 1) {
    bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return encodeBase58(bytes);
}

export function normalizeMarketKey(value: string): string {
  return value.toLowerCase();
}
