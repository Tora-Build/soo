//! `ResolutionCommitment` — the per-market commitment to a T\* voiding
//! computation.
//!
//! One PDA per market, published by the adjudicator inside the veto window and
//! final from the moment that window closes. It holds a merkle root over one
//! leaf per wallet; the leaf table itself lives off-chain and is reproducible
//! from the market's public event tape (`docs/design/t-star-voiding.md`).
//!
//! ## PDA seed convention
//!
//! Seeds = `[b"resolution", market_pubkey]`, derived under `sooth_core::ID`.
//!
//! ## Absence is the default, and it means "no voiding"
//!
//! The overwhelming majority of markets never publish one. `redeem_amm_position`
//! therefore treats an uninitialised account at this address as "pay the
//! position in full", exactly as it did before this account existed. That is
//! why the account is loaded as raw and checked for emptiness rather than
//! declared as an `Account<'_, ResolutionCommitment>`, which would fail the
//! instruction outright for every ordinary market.

use anchor_lang::prelude::*;

use crate::merkle::hash_leaf;

/// PDA seed for the per-market resolution commitment.
pub const RESOLUTION_COMMITMENT_SEED: &[u8] = b"resolution";

#[account]
pub struct ResolutionCommitment {
    /// `sooth_core::Market` this commitment resolves. Redundant with the
    /// seeds and checked anyway: the seeds bind the ADDRESS, this binds the
    /// CONTENT, and a leaf proof is only as good as the root it is checked
    /// against belonging to the market being redeemed.
    pub market: Pubkey,

    /// Root of the per-wallet entitlement tree. Leaves are composed by
    /// [`voided_leaf`]; the shape is in `crate::merkle`.
    pub merkle_root: [u8; 32],

    /// The moment the market's event actually became public knowledge. Every
    /// trade at or before this is honest; everything after it is what the
    /// tree voids. Unix seconds, and always
    /// `market.start_time <= t_star <= min(attested_at, market.deadline)`.
    pub t_star: i64,

    /// Number of leaves in the tree. Not consulted by proof verification —
    /// it is published so a third party can reproduce the tree's exact shape
    /// (the odd-node promotion rule depends on the leaf count at every level)
    /// and therefore its root.
    pub leaf_count: u32,

    /// Total USDC the resolver claims the void path will pay out across all
    /// leaves. A ceiling, not an estimate: see `void_refund_paid_usdc`.
    pub total_void_refund_usdc: u64,

    /// Running total actually paid out by `redeem_amm_position`'s void path.
    /// Together with the field above this caps the cash the whole mechanism
    /// can move at a number published BEFORE the veto window closed — so an
    /// observer can compare the claim against the vault while there is still
    /// time to revoke it. Without the cap, a tree whose per-leaf bounds each
    /// pass could still drain the vault in aggregate.
    pub void_refund_paid_usdc: u64,

    /// Who published, and therefore who gets the rent back on revoke.
    pub publisher: Pubkey,

    /// Unix seconds at publication. The veto deadline is derived from the
    /// ATTESTATION, not from this — publishing late must not extend the
    /// window in which the commitment can be scrutinised.
    pub published_at: i64,

    /// Bump for the `ResolutionCommitment` PDA.
    pub bump: u8,

    /// Forward-compat padding. Adding a field consumes bytes from here
    /// instead of changing the account's length, so no migration is needed:
    /// Solana accounts are fixed-length buffers, and an `#[account]` struct
    /// that outgrows its buffer fails to deserialize on every instruction
    /// that loads it.
    ///
    /// When you add a field, shrink this by exactly its serialized size and
    /// leave `SPACE` unchanged.
    pub _reserved: [u8; 32],
}

impl ResolutionCommitment {
    /// Borsh-serialized size for rent calculation.
    pub const SPACE: usize = 8     // discriminator
        + 32                       // market
        + 32                       // merkle_root
        + 8                        // t_star
        + 4                        // leaf_count
        + 8                        // total_void_refund_usdc
        + 8                        // void_refund_paid_usdc
        + 32                       // publisher
        + 8                        // published_at
        + 1                        // bump
        + 32; // _reserved

    /// Void refund still payable under the published ceiling.
    pub fn void_refund_remaining(&self) -> u64 {
        self.total_void_refund_usdc
            .saturating_sub(self.void_refund_paid_usdc)
    }
}

/// The leaf a wallet redeems against.
///
/// ```text
/// sha256( 0x00 ‖ market(32) ‖ user(32)
///       ‖ valid_yes_wad(16 LE) ‖ valid_no_wad(16 LE) ‖ void_refund_usdc(8 LE) )
/// ```
///
/// Every field is FIXED WIDTH, which is load-bearing: the hash is over a plain
/// concatenation with no separators, so variable-width fields would let two
/// different entitlements share a preimage.
///
/// `market` is inside the leaf as well as in the PDA seeds so that a proof
/// built for one market's tree cannot be presented against another's root.
pub fn voided_leaf(
    market: &Pubkey,
    user: &Pubkey,
    valid_yes_wad: u128,
    valid_no_wad: u128,
    void_refund_usdc: u64,
) -> [u8; 32] {
    let yes = valid_yes_wad.to_le_bytes();
    let no = valid_no_wad.to_le_bytes();
    let refund = void_refund_usdc.to_le_bytes();
    hash_leaf(&[market.as_ref(), user.as_ref(), &yes, &no, &refund])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> ResolutionCommitment {
        ResolutionCommitment {
            market: Pubkey::new_unique(),
            merkle_root: [3u8; 32],
            t_star: 1_700_000_000,
            leaf_count: 7,
            total_void_refund_usdc: 1_000_000,
            void_refund_paid_usdc: 0,
            publisher: Pubkey::new_unique(),
            published_at: 1_700_000_500,
            bump: 254,
            _reserved: [0u8; 32],
        }
    }

    #[test]
    fn space_constant_is_self_consistent() {
        // Anchor's `init` rents exactly SPACE bytes and never re-checks it
        // against the struct. A field added without bumping this under-rents
        // the account, and the failure shows up as a deserialize error much
        // later, on a different instruction.
        let expected = 8 + 32 + 32 + 8 + 4 + 8 + 8 + 32 + 8 + 1 + 32;
        assert_eq!(ResolutionCommitment::SPACE, expected);
        assert_eq!(ResolutionCommitment::SPACE, 173);
    }

    #[test]
    fn the_account_serializes_within_its_space() {
        let c = fresh();
        let mut buf = Vec::new();
        c.serialize(&mut buf).unwrap();
        // +8 for the discriminator Anchor writes ahead of the body.
        assert_eq!(buf.len() + 8, ResolutionCommitment::SPACE);
    }

    #[test]
    fn the_remaining_refund_never_goes_negative() {
        let mut c = fresh();
        c.void_refund_paid_usdc = c.total_void_refund_usdc;
        assert_eq!(c.void_refund_remaining(), 0);
        // Not reachable through the instruction, which refuses to overshoot —
        // but a saturating read here means a corrupt account cannot wrap into
        // an enormous allowance.
        c.void_refund_paid_usdc = c.total_void_refund_usdc + 1;
        assert_eq!(c.void_refund_remaining(), 0);
    }

    #[test]
    fn a_leaf_is_deterministic() {
        let m = Pubkey::new_unique();
        let u = Pubkey::new_unique();
        assert_eq!(voided_leaf(&m, &u, 1, 2, 3), voided_leaf(&m, &u, 1, 2, 3));
    }

    #[test]
    fn every_field_changes_the_leaf() {
        let m = Pubkey::new_unique();
        let u = Pubkey::new_unique();
        let base = voided_leaf(&m, &u, 10, 20, 30);
        assert_ne!(base, voided_leaf(&Pubkey::new_unique(), &u, 10, 20, 30));
        assert_ne!(base, voided_leaf(&m, &Pubkey::new_unique(), 10, 20, 30));
        assert_ne!(base, voided_leaf(&m, &u, 11, 20, 30));
        assert_ne!(base, voided_leaf(&m, &u, 10, 21, 30));
        assert_ne!(base, voided_leaf(&m, &u, 10, 20, 31));
    }

    #[test]
    fn the_yes_and_no_legs_are_not_interchangeable() {
        // Fixed-width fields are what stop these two from sharing a preimage.
        let m = Pubkey::new_unique();
        let u = Pubkey::new_unique();
        assert_ne!(voided_leaf(&m, &u, 5, 9, 0), voided_leaf(&m, &u, 9, 5, 0));
    }

    #[test]
    fn the_market_and_user_are_not_interchangeable() {
        // Both are 32 bytes and adjacent in the preimage, so swapping them
        // must still change the leaf — it does, because they are different
        // POSITIONS, not different widths. Pinned because a future field
        // reorder that made them symmetric would be silent.
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        assert_ne!(voided_leaf(&a, &b, 1, 1, 1), voided_leaf(&b, &a, 1, 1, 1));
    }

    #[test]
    fn a_leaf_is_reproducible_from_the_documented_preimage() {
        // Independently composed here, byte by byte, from the doc comment
        // above — so a change to field order or endianness fails this test
        // rather than silently invalidating every published tree.
        use anchor_lang::solana_program::hash::hashv;
        let m = Pubkey::new_unique();
        let u = Pubkey::new_unique();
        let (yes, no, refund) = (7u128, 11u128, 13u64);

        let mut preimage = Vec::new();
        preimage.push(crate::merkle::LEAF_DOMAIN);
        preimage.extend_from_slice(m.as_ref());
        preimage.extend_from_slice(u.as_ref());
        preimage.extend_from_slice(&yes.to_le_bytes());
        preimage.extend_from_slice(&no.to_le_bytes());
        preimage.extend_from_slice(&refund.to_le_bytes());
        assert_eq!(preimage.len(), 1 + 32 + 32 + 16 + 16 + 8);

        assert_eq!(
            voided_leaf(&m, &u, yes, no, refund),
            hashv(&[&preimage]).to_bytes()
        );
    }
}
