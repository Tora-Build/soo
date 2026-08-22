// The leaf encoding and the tree shape, pinned against the program.
//
// A tree the program rejects is worthless, and an encoding mismatch is the
// single most likely way to build one — every field is fixed width with no
// separators, so a swapped order or a wrong endianness produces a perfectly
// valid-looking root that verifies nowhere.
//
// So the preimages are composed here a SECOND time, byte by byte, from the
// layout documented in `state/resolution.rs` — the same discipline that file's
// own `a_leaf_is_reproducible_from_the_documented_preimage` test follows. The
// end-to-end proof that this agrees with the Rust verifier is
// `packages/sdk-solana/tests/t-star-voiding-resolver.test.ts`, which hands a
// proof built by THIS module to the real instruction on LiteSVM.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  BOOK_LEAF_DOMAIN,
  LEAF_DOMAIN,
  MAX_MERKLE_PROOF_LEN,
  NODE_DOMAIN,
  ammLeaf,
  bookLeaf,
  buildTree,
  hashPair,
  verifyProof,
} from "../src/void/merkle.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest();
const key = (b) => Buffer.alloc(32, b);

test("the AMM leaf reproduces the documented preimage byte for byte", () => {
  const market = key(0x11);
  const user = key(0x22);
  const [yes, no, refund] = [7n, 11n, 13n];

  const pre = Buffer.concat([
    Buffer.from([LEAF_DOMAIN]),
    market,
    user,
    leU(yes, 16),
    leU(no, 16),
    leU(refund, 8),
  ]);
  assert.equal(pre.length, 1 + 32 + 32 + 16 + 16 + 8);
  assert.deepEqual(ammLeaf(market, user, yes, no, refund), sha256(pre));
});

test("the BOOK leaf reproduces the documented preimage byte for byte", () => {
  const market = key(0x33);
  const user = key(0x44);
  const net = -13n;
  const refund = 17n;

  const netBuf = Buffer.alloc(8);
  netBuf.writeBigInt64LE(net, 0);
  const pre = Buffer.concat([
    Buffer.from([BOOK_LEAF_DOMAIN]),
    market,
    user,
    netBuf,
    leU(refund, 8),
  ]);
  assert.equal(pre.length, 1 + 32 + 32 + 8 + 8);
  assert.deepEqual(bookLeaf(market, user, net, refund), sha256(pre));
});

test("the node hash sorts its pair and uses its own domain", () => {
  const a = Buffer.alloc(32, 0xaa);
  const b = Buffer.alloc(32, 0xbb);
  const expected = sha256(Buffer.concat([Buffer.from([NODE_DOMAIN]), a, b]));
  assert.deepEqual(hashPair(a, b), expected);
  assert.deepEqual(hashPair(b, a), expected, "the pair is order-independent");
});

test("a leaf can never be read as an internal node", () => {
  // The domain bytes are the whole reason a 64-byte leaf preimage cannot be
  // replayed as a node preimage and a proof forged for a leaf never in the tree.
  const a = Buffer.alloc(32, 7);
  const b = Buffer.alloc(32, 9);
  assert.notDeepEqual(ammLeaf(a, b, 0n, 0n, 0n), hashPair(a, b));
  assert.notDeepEqual(bookLeaf(a, b, 0n, 0n), hashPair(a, b));
});

test("an AMM leaf and a book leaf never share a preimage", () => {
  // One tree carries both kinds. If they collided, a seat entitlement would
  // prove an AMM one.
  const m = key(1);
  const u = key(2);
  assert.notDeepEqual(bookLeaf(m, u, 1n, 2n), ammLeaf(m, u, 1n, 0n, 2n));
});

test("every field changes the leaf, and the legs are not interchangeable", () => {
  const m = key(1);
  const u = key(2);
  const base = ammLeaf(m, u, 10n, 20n, 30n);
  assert.notDeepEqual(base, ammLeaf(key(9), u, 10n, 20n, 30n));
  assert.notDeepEqual(base, ammLeaf(m, key(9), 10n, 20n, 30n));
  assert.notDeepEqual(base, ammLeaf(m, u, 11n, 20n, 30n));
  assert.notDeepEqual(base, ammLeaf(m, u, 10n, 21n, 30n));
  assert.notDeepEqual(base, ammLeaf(m, u, 10n, 20n, 31n));
  assert.notDeepEqual(ammLeaf(m, u, 5n, 9n, 0n), ammLeaf(m, u, 9n, 5n, 0n));
});

test("the sign of a book net is part of its leaf", () => {
  // Long YES and long NO are the same magnitude and opposite sides.
  const m = key(1);
  const u = key(2);
  assert.notDeepEqual(bookLeaf(m, u, 7n, 0n), bookLeaf(m, u, -7n, 0n));
});

test("every leaf of every tree size verifies against its own root", () => {
  for (let n = 1; n <= 17; n++) {
    const leaves = Array.from({ length: n }, (_, i) => ammLeaf(key(1), key(i + 1), BigInt(i), 0n, 0n));
    const { root, proofs } = buildTree(leaves);
    for (let i = 0; i < n; i++) {
      assert.ok(verifyProof(leaves[i], proofs[i], root), `leaf ${i} of a ${n}-leaf tree`);
    }
  }
});

test("a single-leaf tree is its own root and its proof is empty", () => {
  const leaf = ammLeaf(key(1), key(2), 1n, 0n, 0n);
  const { root, proofs } = buildTree([leaf]);
  assert.deepEqual(root, leaf);
  assert.equal(proofs[0].length, 0);
  assert.ok(verifyProof(leaf, [], root));
});

test("a three-leaf root promotes the odd node rather than pairing it with itself", () => {
  const l = [1, 2, 3].map((i) => ammLeaf(key(1), key(i), 0n, 0n, 0n));
  const { root } = buildTree(l);
  assert.deepEqual(root, hashPair(hashPair(l[0], l[1]), l[2]));
});

test("proof depth stays logarithmic", () => {
  // Not cosmetic: the proof travels in the transaction, so its growth decides
  // whether a large market can redeem at all.
  const leaves = Array.from({ length: 1000 }, (_, i) => ammLeaf(key(1), key(i % 250), BigInt(i), 0n, 0n));
  const { proofs } = buildTree(leaves);
  assert.ok(proofs[0].length <= 10, `1000 leaves gave a ${proofs[0].length}-deep proof`);
  assert.ok(proofs[0].length <= MAX_MERKLE_PROOF_LEN);
});

test("a tampered leaf, a foreign proof and a truncated proof all fail", () => {
  const leaves = Array.from({ length: 8 }, (_, i) => ammLeaf(key(1), key(i + 1), BigInt(i), 0n, 0n));
  const { root, proofs } = buildTree(leaves);

  const tampered = Buffer.from(leaves[3]);
  tampered[0] ^= 1;
  assert.equal(verifyProof(tampered, proofs[3], root), false);
  assert.equal(verifyProof(leaves[3], proofs[5], root), false);
  assert.equal(verifyProof(leaves[3], proofs[3].slice(0, -1), root), false);
  assert.equal(verifyProof(leaves[3], [...proofs[3], Buffer.alloc(32, 0xab)], root), false);
});

test("an over-long proof is refused rather than walked", () => {
  const leaf = ammLeaf(key(1), key(2), 0n, 0n, 0n);
  const proof = Array.from({ length: MAX_MERKLE_PROOF_LEN + 1 }, () => Buffer.alloc(32));
  assert.equal(verifyProof(leaf, proof, leaf), false);
});

test("an empty tree is refused — the program rejects leaf_count 0", () => {
  assert.throws(() => buildTree([]), /empty tree/);
});

function leU(v, width) {
  const b = Buffer.alloc(width);
  let x = BigInt(v);
  for (let i = 0; i < width; i++) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}
