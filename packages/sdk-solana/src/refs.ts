// `MarketRef` and `AddressRef` are chain-prefixed opaque strings per the
// integrator contract (`docs/integrator-contract.md §3`). The Solana adapter
// uses `sol:<base58>` prefixes so a quick prefix check disambiguates from
// EVM `0x…` hashes when both adapters coexist in the umbrella SDK.

import { PublicKey } from "@solana/web3.js";

export const SOL_REF_PREFIX = "sol:";

export function encodePubkeyRef(key: PublicKey): string {
  return `${SOL_REF_PREFIX}${key.toBase58()}`;
}

export function decodePubkeyRef(ref: string): PublicKey {
  if (!ref.startsWith(SOL_REF_PREFIX)) {
    throw new Error(
      `expected ref with "${SOL_REF_PREFIX}" prefix, got: ${ref}`,
    );
  }
  return new PublicKey(ref.slice(SOL_REF_PREFIX.length));
}

export function encodeSignatureRef(sig: string): string {
  return `${SOL_REF_PREFIX}${sig}`;
}
