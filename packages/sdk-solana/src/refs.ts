// `MarketRef` and `AddressRef` are chain-prefixed opaque strings per the
// integrator contract (`docs/integrator-contract.md §3`). Solana refs are
// `sol:<base58>`, so a prefix check tells them apart from EVM `0x…` hashes
// when both adapters are loaded.
//
// `decodePubkeyRef` REJECTS an unprefixed string rather than assuming it is
// base58: a bare `0x…` would otherwise be decoded as base58 into some other
// valid-looking pubkey. Note base58 is case-sensitive — a ref that has been
// lowercased anywhere is not recoverable.

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
