//! Binary merkle tree verification over sha256.
//!
//! Used by the T\* voiding path (`docs/design/t-star-voiding.md`): the
//! resolver publishes a root over one leaf per wallet, and a redeeming wallet
//! carries the proof for its own leaf. Nothing here allocates or touches
//! accounts — it is pure, so the whole thing is exercised in unit tests.
//!
//! # Shape
//!
//! ```text
//! leaf hash := sha256(0x00 ‖ <leaf preimage>)     — composed by the caller
//! node hash := sha256(0x01 ‖ min(a,b) ‖ max(a,b))
//! ```
//!
//! Two rules that have to hold together:
//!
//!   - **Sorted pairs.** The pair is hashed in ascending byte order, so a
//!     proof carries no direction bits and is just a list of siblings.
//!   - **Distinct domain bytes for leaves and nodes.** With sorted pairs and
//!     no domain separation, a 64-byte leaf preimage could be replayed as an
//!     internal node and a proof forged for a leaf that was never in the tree.
//!     The prefixes are what make that impossible, and they are also what
//!     makes the odd-node rule below safe.
//!
//! An odd node at any level is promoted to the next level unchanged rather
//! than paired with itself. Promotion is the cheaper rule and, given domain
//! separation, does not create the duplicate-leaf ambiguity it would otherwise.

use anchor_lang::solana_program::hash::hashv;

/// Domain byte prefixed to every leaf preimage.
pub const LEAF_DOMAIN: u8 = 0x00;

/// Domain byte prefixed to every internal-node preimage.
pub const NODE_DOMAIN: u8 = 0x01;

/// Domain byte prefixed to a BOOK entitlement leaf.
///
/// One tree carries both kinds of leaf — a wallet that traded both venues has
/// one of each — so the two shapes need separating for the same reason leaves
/// and nodes do: an AMM leaf and a book leaf must never share a preimage, or a
/// proof of one would prove the other. The redeeming instruction composes only
/// its own domain, so `redeem_book_seat` cannot be handed an AMM entitlement
/// and vice versa.
pub const BOOK_LEAF_DOMAIN: u8 = 0x02;

/// Longest proof the program accepts, and therefore the deepest tree.
///
/// 32 levels is 2^32 leaves — far past any market, and far past what the
/// 1232-byte transaction could carry anyway (32 levels is 1024 bytes of proof
/// alone). It exists to bound the hashing loop for an input that is entirely
/// caller-controlled, not because any real tree approaches it.
pub const MAX_MERKLE_PROOF_LEN: usize = 32;

/// Hash a leaf preimage into a leaf node.
///
/// Callers pass the preimage as slices so the composition stays visible at the
/// call site; the domain byte is prepended here so no caller can forget it.
pub fn hash_leaf(parts: &[&[u8]]) -> [u8; 32] {
    hash_leaf_in_domain(LEAF_DOMAIN, parts)
}

/// Hash a leaf preimage under an explicit domain byte.
///
/// The domain is what keeps two leaf KINDS in one tree from colliding, so it
/// is a parameter rather than a constant here — and every caller passes a
/// distinct one.
pub fn hash_leaf_in_domain(domain_byte: u8, parts: &[&[u8]]) -> [u8; 32] {
    let domain = [domain_byte];
    let mut buf: Vec<&[u8]> = Vec::with_capacity(parts.len() + 1);
    buf.push(&domain);
    buf.extend_from_slice(parts);
    hashv(&buf).to_bytes()
}

/// Combine two child hashes into their parent. Order-independent by
/// construction: the pair is sorted, so a caller cannot influence the result
/// by presenting the siblings the other way round.
pub fn hash_pair(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let domain = [NODE_DOMAIN];
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    hashv(&[&domain, &lo, &hi]).to_bytes()
}

/// True iff `leaf` is a member of the tree with root `root`, witnessed by
/// `proof`.
///
/// A proof longer than [`MAX_MERKLE_PROOF_LEN`] is refused rather than
/// evaluated; an empty proof is meaningful and means "the tree is a single
/// leaf", so `leaf == root`.
pub fn verify_proof(leaf: [u8; 32], proof: &[[u8; 32]], root: [u8; 32]) -> bool {
    if proof.len() > MAX_MERKLE_PROOF_LEN {
        return false;
    }
    let mut node = leaf;
    for sibling in proof {
        node = hash_pair(node, *sibling);
    }
    node == root
}

/// Build a root from an ordered leaf list. Off-chain/test helper — the
/// on-chain path only ever verifies — kept beside [`verify_proof`] so the two
/// halves of the shape cannot drift apart.
///
/// `None` for an empty list: a tree with no leaves has no root, and returning
/// a zero root would make an all-zero commitment look verifiable.
pub fn compute_root(leaves: &[[u8; 32]]) -> Option<[u8; 32]> {
    if leaves.is_empty() {
        return None;
    }
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for chunk in level.chunks(2) {
            next.push(match chunk {
                [a, b] => hash_pair(*a, *b),
                // Odd node out: promoted unchanged.
                [a] => *a,
                _ => unreachable!("chunks(2) yields 1 or 2 elements"),
            });
        }
        level = next;
    }
    Some(level[0])
}

/// The sibling list proving `index` in a tree over `leaves`. Off-chain/test
/// helper, mirroring [`compute_root`]'s promotion rule.
pub fn compute_proof(leaves: &[[u8; 32]], index: usize) -> Option<Vec<[u8; 32]>> {
    if index >= leaves.len() {
        return None;
    }
    let mut proof = Vec::new();
    let mut level = leaves.to_vec();
    let mut idx = index;
    while level.len() > 1 {
        let sibling = if idx.is_multiple_of(2) {
            idx + 1
        } else {
            idx - 1
        };
        // A promoted odd node has no sibling at this level and contributes
        // nothing to the proof.
        if sibling < level.len() {
            proof.push(level[sibling]);
        }
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for chunk in level.chunks(2) {
            next.push(match chunk {
                [a, b] => hash_pair(*a, *b),
                [a] => *a,
                _ => unreachable!("chunks(2) yields 1 or 2 elements"),
            });
        }
        level = next;
        idx /= 2;
    }
    Some(proof)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Leaves that are recognisable in a failure message. Content is
    /// irrelevant to the tree — only the hashes are.
    fn leaves(n: usize) -> Vec<[u8; 32]> {
        (0..n).map(|i| hash_leaf(&[&[i as u8][..]])).collect()
    }

    /// The reference the rest of the tests are checked against: the pair rule
    /// spelled out inline, independently of `hash_pair`, so a change to the
    /// domain byte or the sort order fails here first.
    fn reference_pair(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        let mut preimage = Vec::with_capacity(65);
        preimage.push(NODE_DOMAIN);
        preimage.extend_from_slice(&lo);
        preimage.extend_from_slice(&hi);
        hashv(&[&preimage]).to_bytes()
    }

    #[test]
    fn the_pair_hash_matches_an_independently_written_one() {
        let l = leaves(2);
        assert_eq!(hash_pair(l[0], l[1]), reference_pair(l[0], l[1]));
    }

    #[test]
    fn the_pair_hash_ignores_argument_order() {
        let l = leaves(2);
        assert_eq!(hash_pair(l[0], l[1]), hash_pair(l[1], l[0]));
    }

    #[test]
    fn a_leaf_can_never_be_read_as_an_internal_node() {
        // The domain bytes are the whole reason a 64-byte leaf preimage
        // cannot be replayed as a node preimage. If both used the same
        // prefix these two would collide and proofs would be forgeable.
        let a = [7u8; 32];
        let b = [9u8; 32];
        let as_leaf = hash_leaf(&[&a, &b]);
        let as_node = hash_pair(a, b);
        assert_ne!(as_leaf, as_node);
    }

    #[test]
    fn a_single_leaf_tree_is_its_own_root() {
        let l = leaves(1);
        assert_eq!(compute_root(&l).unwrap(), l[0]);
        assert!(verify_proof(l[0], &[], l[0]));
    }

    #[test]
    fn an_empty_tree_has_no_root() {
        assert!(compute_root(&[]).is_none());
    }

    #[test]
    fn a_two_leaf_root_is_the_pair_of_its_leaves() {
        let l = leaves(2);
        assert_eq!(compute_root(&l).unwrap(), reference_pair(l[0], l[1]));
    }

    #[test]
    fn a_three_leaf_root_promotes_the_odd_node() {
        // Built by hand: (0,1) pair, 2 promoted, then those two paired.
        let l = leaves(3);
        let expected = reference_pair(reference_pair(l[0], l[1]), l[2]);
        assert_eq!(compute_root(&l).unwrap(), expected);
    }

    #[test]
    fn every_leaf_of_every_tree_size_verifies() {
        for n in 1..=17 {
            let l = leaves(n);
            let root = compute_root(&l).unwrap();
            for (i, leaf) in l.iter().enumerate() {
                let proof = compute_proof(&l, i).unwrap();
                assert!(
                    verify_proof(*leaf, &proof, root),
                    "leaf {i} of a {n}-leaf tree failed to verify"
                );
            }
        }
    }

    #[test]
    fn proof_depth_is_logarithmic() {
        // Not cosmetic: the proof travels in the transaction, so its growth
        // is what decides whether a large market can redeem at all.
        let l = leaves(1000);
        let proof = compute_proof(&l, 0).unwrap();
        assert!(
            proof.len() <= 10,
            "1000 leaves gave a {}-deep proof",
            proof.len()
        );
    }

    #[test]
    fn a_tampered_leaf_fails() {
        let l = leaves(8);
        let root = compute_root(&l).unwrap();
        let proof = compute_proof(&l, 3).unwrap();
        let mut tampered = l[3];
        tampered[0] ^= 1;
        assert!(!verify_proof(tampered, &proof, root));
    }

    #[test]
    fn a_leaf_from_a_different_tree_fails() {
        let mine = leaves(8);
        let other: Vec<[u8; 32]> = (100..108u8).map(|i| hash_leaf(&[&[i][..]])).collect();
        let my_root = compute_root(&mine).unwrap();
        let their_proof = compute_proof(&other, 3).unwrap();
        assert!(!verify_proof(other[3], &their_proof, my_root));
    }

    #[test]
    fn a_valid_leaf_with_someone_elses_proof_fails() {
        let l = leaves(8);
        let root = compute_root(&l).unwrap();
        let wrong_proof = compute_proof(&l, 5).unwrap();
        assert!(!verify_proof(l[3], &wrong_proof, root));
    }

    #[test]
    fn a_tampered_proof_node_fails() {
        let l = leaves(8);
        let root = compute_root(&l).unwrap();
        let mut proof = compute_proof(&l, 3).unwrap();
        proof[0][31] ^= 1;
        assert!(!verify_proof(l[3], &proof, root));
    }

    #[test]
    fn a_truncated_proof_fails() {
        let l = leaves(8);
        let root = compute_root(&l).unwrap();
        let mut proof = compute_proof(&l, 3).unwrap();
        proof.pop();
        assert!(!verify_proof(l[3], &proof, root));
    }

    #[test]
    fn an_extended_proof_fails() {
        let l = leaves(8);
        let root = compute_root(&l).unwrap();
        let mut proof = compute_proof(&l, 3).unwrap();
        proof.push([0xAB; 32]);
        assert!(!verify_proof(l[3], &proof, root));
    }

    #[test]
    fn an_over_long_proof_is_refused_rather_than_walked() {
        // The loop is over caller-supplied data on a metered runtime, so the
        // ceiling is a guard, not a nicety.
        let l = leaves(1);
        let proof = vec![[0u8; 32]; MAX_MERKLE_PROOF_LEN + 1];
        assert!(!verify_proof(l[0], &proof, l[0]));
    }

    #[test]
    fn an_internal_node_reaches_the_root_but_is_not_a_leaf_hash() {
        // The classic second-preimage attack: pass an internal node as your
        // "leaf" and prove it with the remaining path. Domain separation makes
        // the node hash unreachable as a leaf hash, and this pins that.
        let l = leaves(4);
        let root = compute_root(&l).unwrap();
        let internal = hash_pair(l[0], l[1]);
        let short_proof = vec![hash_pair(l[2], l[3])];
        // The forged path DOES reach the root — that is the attack — but the
        // forged "leaf" is a node hash, which `hash_leaf` can never produce.
        assert!(verify_proof(internal, &short_proof, root));
        for leaf in &l {
            assert_ne!(*leaf, internal, "a leaf hash collided with a node hash");
        }
    }

    #[test]
    fn distinct_leaf_preimages_give_distinct_leaves() {
        let a = hash_leaf(&[b"a", b"bc"]);
        let b = hash_leaf(&[b"ab", b"c"]);
        // `hashv` concatenates, so the SPLIT is not part of the preimage.
        // Callers must therefore use fixed-width fields — which the voiding
        // leaf does. This test records the property rather than wishing it away.
        assert_eq!(a, b);
        assert_ne!(hash_leaf(&[b"a"]), hash_leaf(&[b"b"]));
    }

    #[test]
    fn the_three_domains_are_mutually_unreachable() {
        // One tree holds AMM leaves, book leaves and internal nodes. Any two
        // sharing a preimage would make a proof of one a proof of another.
        let parts: &[&[u8]] = &[&[1u8; 32][..], &[2u8; 32][..]];
        let amm = hash_leaf(parts);
        let book = hash_leaf_in_domain(BOOK_LEAF_DOMAIN, parts);
        let node = hash_pair([1u8; 32], [2u8; 32]);
        assert_ne!(amm, book);
        assert_ne!(amm, node);
        assert_ne!(book, node);
        assert_ne!(LEAF_DOMAIN, BOOK_LEAF_DOMAIN);
        assert_ne!(NODE_DOMAIN, BOOK_LEAF_DOMAIN);
    }

    #[test]
    fn compute_proof_refuses_an_out_of_range_index() {
        let l = leaves(4);
        assert!(compute_proof(&l, 4).is_none());
        assert!(compute_proof(&[], 0).is_none());
    }
}
