// The T* entitlement tree: leaf encoding and merkle shape.
//
// This file is written against the PROGRAM, byte for byte. Every constant
// below has a counterpart in `sooth_core`:
//
//   leaf domains       `merkle.rs::{LEAF_DOMAIN, NODE_DOMAIN, BOOK_LEAF_DOMAIN}`
//   AMM leaf preimage  `state/resolution.rs::voided_leaf`
//   book leaf preimage `state/resolution.rs::voided_book_leaf`
//   pairing + odd node `merkle.rs::{hash_pair, compute_root, compute_proof}`
//
// A tree the program rejects is worthless, so nothing here is imported from
// the program or generated from it — it is written independently and pinned
// by tests that compose the preimage a second time (`test/void-merkle.test.mjs`)
// and by a round-trip that hands a proof built here to the real instruction
// on LiteSVM (`packages/sdk-solana/tests/t-star-voiding-resolver.test.ts`).
//
// ## Shape
//
//   amm  leaf = sha256( 0x00 ‖ market(32) ‖ user(32)
//                     ‖ valid_yes_wad(16 LE) ‖ valid_no_wad(16 LE)
//                     ‖ void_refund_usdc(8 LE) )
//   book leaf = sha256( 0x02 ‖ market(32) ‖ user(32)
//                     ‖ valid_net(8 LE, two's complement) ‖ refund(8 LE) )
//   node      = sha256( 0x01 ‖ min(a,b) ‖ max(a,b) )
//
// Pairs are SORTED, so a proof is a bare sibling list with no direction bits.
// An odd node at any level is PROMOTED unchanged rather than paired with
// itself. Both rules are the program's; deviating from either produces roots
// that verify nowhere.

import { createHash } from "node:crypto";

export const LEAF_DOMAIN = 0x00;
export const NODE_DOMAIN = 0x01;
export const BOOK_LEAF_DOMAIN = 0x02;

/** `merkle.rs::MAX_MERKLE_PROOF_LEN` — the deepest proof the program walks. */
export const MAX_MERKLE_PROOF_LEN = 32;

const sha256 = (...parts) =>
  createHash("sha256").update(Buffer.concat(parts)).digest();

/** u128 little-endian, 16 bytes. Fixed width is what stops two leaves sharing a preimage. */
export function u128le(v) {
  const b = Buffer.alloc(16);
  const x = BigInt(v);
  if (x < 0n) throw new Error(`u128 cannot be negative: ${x}`);
  b.writeBigUInt64LE(x & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(x >> 64n, 8);
  return b;
}

/** u64 little-endian, 8 bytes. */
export function u64le(v) {
  const b = Buffer.alloc(8);
  const x = BigInt(v);
  if (x < 0n) throw new Error(`u64 cannot be negative: ${x}`);
  b.writeBigUInt64LE(x, 0);
  return b;
}

/** i64 little-endian, 8 bytes, two's complement — `valid_net`'s encoding. */
export function i64le(v) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v), 0);
  return b;
}

const key32 = (k) => {
  const buf = typeof k?.toBuffer === "function" ? k.toBuffer() : Buffer.from(k);
  if (buf.length !== 32) throw new Error(`expected a 32-byte pubkey, got ${buf.length}`);
  return buf;
};

/** `voided_leaf` — the AMM entitlement a wallet redeems `redeem_amm_position` against. */
export function ammLeaf(market, user, validYesWad, validNoWad, voidRefundUsdc) {
  return sha256(
    Buffer.from([LEAF_DOMAIN]),
    key32(market),
    key32(user),
    u128le(validYesWad),
    u128le(validNoWad),
    u64le(voidRefundUsdc),
  );
}

/** `voided_book_leaf` — the BOOK entitlement, a second KIND of leaf in the same tree. */
export function bookLeaf(market, user, validNet, refundUsdc) {
  return sha256(
    Buffer.from([BOOK_LEAF_DOMAIN]),
    key32(market),
    key32(user),
    i64le(validNet),
    u64le(refundUsdc),
  );
}

/** `hash_pair` — order-independent by construction. */
export function hashPair(a, b) {
  return Buffer.compare(a, b) <= 0
    ? sha256(Buffer.from([NODE_DOMAIN]), a, b)
    : sha256(Buffer.from([NODE_DOMAIN]), b, a);
}

/**
 * Root and per-leaf proofs over an ORDERED leaf list.
 *
 * The order is part of the commitment — `leaf_count` is published precisely so
 * a third party can reproduce the promotion rule at every level — so callers
 * must order deterministically (`entitlements.mjs::orderLeaves` does).
 *
 * A single-leaf tree is its own root and its proof is empty, which the program
 * accepts (`verify_proof` with an empty proof means `leaf == root`).
 */
export function buildTree(leaves) {
  if (leaves.length === 0) {
    throw new Error("an empty tree has no root — the program refuses leaf_count 0");
  }
  const proofs = leaves.map(() => []);
  let position = leaves.map((_, i) => i);
  let level = leaves;
  while (level.length > 1) {
    for (const [k, pos] of position.entries()) {
      const sibling = pos % 2 === 0 ? pos + 1 : pos - 1;
      // A promoted odd node has no sibling at this level and contributes
      // nothing to the proof.
      if (sibling < level.length) proofs[k].push(level[sibling]);
    }
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    position = position.map((pos) => Math.floor(pos / 2));
    level = next;
  }
  return { root: level[0], proofs };
}

/** `verify_proof`, mirrored, so the resolver can check its own output before publishing. */
export function verifyProof(leaf, proof, root) {
  if (proof.length > MAX_MERKLE_PROOF_LEN) return false;
  let node = leaf;
  for (const sibling of proof) node = hashPair(node, sibling);
  return node.equals(root);
}

export const hex = (buf) => `0x${Buffer.from(buf).toString("hex")}`;
