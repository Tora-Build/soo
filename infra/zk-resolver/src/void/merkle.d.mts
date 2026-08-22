// Types for the merkle module. The resolver runs as plain ESM with no build
// step, and the SDK suite drives THESE modules against the on-chain verifier
// — a compiled copy would prove the copy, not the resolver — so the boundary
// is declared here rather than the source being ported to TypeScript.

export const LEAF_DOMAIN: number;
export const NODE_DOMAIN: number;
export const BOOK_LEAF_DOMAIN: number;
export const MAX_MERKLE_PROOF_LEN: number;

/** Anything carrying a 32-byte pubkey: a web3 PublicKey or raw bytes. */
export type KeyLike = { toBuffer(): Buffer } | Uint8Array | Buffer;

export function u128le(v: bigint): Buffer;
export function u64le(v: bigint): Buffer;
export function i64le(v: bigint): Buffer;

/** Leaf preimage for an AMM entitlement, byte-identical to the program's. */
export function ammLeaf(
  market: KeyLike,
  user: KeyLike,
  validYesWad: bigint,
  validNoWad: bigint,
  voidRefundUsdc: bigint,
): Buffer;

/** Leaf preimage for a book entitlement; `validNet` is signed. */
export function bookLeaf(
  market: KeyLike,
  user: KeyLike,
  validNet: bigint,
  refundUsdc: bigint,
): Buffer;

export function hashPair(a: Buffer, b: Buffer): Buffer;

/** Sorted-pair tree; odd nodes are promoted, matching the verifier. */
export function buildTree(leaves: Buffer[]): {
  root: Buffer;
  proofs: Buffer[][];
  leaves: Buffer[];
};

export function verifyProof(leaf: Buffer, proof: Buffer[], root: Buffer): boolean;

export const hex: (buf: Buffer | Uint8Array) => string;
