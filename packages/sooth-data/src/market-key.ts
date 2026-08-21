// `marketKey` — the opaque 32-byte identifier the demo and this service use to
// refer to a market.
//
// A Solana market address is already 32 bytes, so the key IS the pubkey's own
// bytes rendered as hex. No hash, which makes the mapping a bijection: zero
// collisions, and invertible, so any market resolves without appearing in a
// metadata table.
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

/**
 * Case-fold a marketKey for use as a map key.
 *
 * Safe only because a marketKey is HEX. Never pass a base58 address through
 * here: base58 is case-sensitive and lowercasing one destroys it.
 */
export function normalizeMarketKey(value: string): string {
  return value.toLowerCase();
}
