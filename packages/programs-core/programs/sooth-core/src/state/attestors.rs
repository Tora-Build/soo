//! Attestor quorum — M-of-N committee attestation.
//!
//! A market's single adjudicator key rules alone; a committee market wants N
//! named attestors of whom M must agree before an outcome registers. This
//! side PDA holds the roster, the threshold, and each member's current vote;
//! when agreeing votes reach the threshold, the entry's attestation is
//! written exactly as a single-key `attest_outcome` would write it — same
//! veto window, same settle path, same events downstream.
//!
//! Additive by design: the entry's authority retains their unilateral
//! attest. The quorum is an ALTERNATIVE ruling path (a committee the
//! authority convenes), not a lock on the authority's key — locking that key
//! out is a future flag the entry currently has no spare byte for, and a
//! committee that does not trust its own convener should simply be the
//! authority itself via a multisig.
//!
//! Votes are mutable until quorum fires: a member may change their mind. If
//! a guardian veto later CLEARS the attestation, the standing votes remain
//! and any member may adjust and re-trigger quorum — the re-resolution loop
//! works for committees exactly as it does for single keys.

use anchor_lang::prelude::*;

pub const ATTESTOR_SET_SEED: &[u8] = b"attestors";
pub const MAX_ATTESTORS: usize = 5;
/// Sentinel for "has not voted".
pub const NO_VOTE: u8 = u8::MAX;

#[account]
pub struct AttestorSet {
    pub market: Pubkey,
    pub attestors: [Pubkey; MAX_ATTESTORS],
    /// Parallel to `attestors`: each member's current vote (0/1/2), or
    /// `NO_VOTE`. Slot i belongs to attestors[i]; swap-remove moves the vote
    /// with the key.
    pub votes: [u8; MAX_ATTESTORS],
    pub count: u8,
    /// Agreeing votes required to register an attestation. 0 = unconfigured
    /// (the set exists but cannot rule).
    pub threshold: u8,
    pub bump: u8,
}

impl AttestorSet {
    pub const SIZE: usize = 8 + 32 + 32 * MAX_ATTESTORS + MAX_ATTESTORS + 1 + 1 + 1;

    pub fn member_index(&self, key: &Pubkey) -> Option<usize> {
        self.attestors[..self.count as usize]
            .iter()
            .position(|a| a == key)
    }

    pub fn add(&mut self, key: Pubkey) -> std::result::Result<(), AttestorSetError> {
        if self.member_index(&key).is_some() {
            return Err(AttestorSetError::AlreadyPresent);
        }
        if (self.count as usize) >= MAX_ATTESTORS {
            return Err(AttestorSetError::Full);
        }
        self.attestors[self.count as usize] = key;
        self.votes[self.count as usize] = NO_VOTE;
        self.count += 1;
        Ok(())
    }

    pub fn remove(&mut self, key: &Pubkey) -> std::result::Result<(), AttestorSetError> {
        let idx = self
            .member_index(key)
            .ok_or(AttestorSetError::NotFound)?;
        let last = self.count as usize - 1;
        self.attestors[idx] = self.attestors[last];
        self.votes[idx] = self.votes[last];
        self.attestors[last] = Pubkey::default();
        self.votes[last] = NO_VOTE;
        self.count -= 1;
        // A shrunken roster must still be able to satisfy its threshold.
        if self.threshold > self.count {
            self.threshold = self.count;
        }
        Ok(())
    }

    /// Record `outcome` for `key` and return how many members now agree.
    pub fn vote(
        &mut self,
        key: &Pubkey,
        outcome: u8,
    ) -> std::result::Result<u8, AttestorSetError> {
        let idx = self.member_index(key).ok_or(AttestorSetError::NotFound)?;
        self.votes[idx] = outcome;
        Ok(self.votes[..self.count as usize]
            .iter()
            .filter(|v| **v == outcome)
            .count() as u8)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AttestorSetError {
    AlreadyPresent,
    Full,
    NotFound,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_with(keys: &[Pubkey], threshold: u8) -> AttestorSet {
        let mut s = AttestorSet {
            market: Pubkey::new_unique(),
            attestors: [Pubkey::default(); MAX_ATTESTORS],
            votes: [NO_VOTE; MAX_ATTESTORS],
            count: 0,
            threshold,
            bump: 0,
        };
        for k in keys {
            s.add(*k).unwrap();
        }
        s
    }

    #[test]
    fn quorum_counts_only_agreeing_votes() {
        let keys: Vec<Pubkey> = (0..3).map(|_| Pubkey::new_unique()).collect();
        let mut s = set_with(&keys, 2);
        assert_eq!(s.vote(&keys[0], 1).unwrap(), 1);
        assert_eq!(s.vote(&keys[1], 0).unwrap(), 1); // disagreement doesn't count
        assert_eq!(s.vote(&keys[2], 1).unwrap(), 2); // quorum for YES
    }

    #[test]
    fn a_member_may_change_their_vote() {
        let keys: Vec<Pubkey> = (0..2).map(|_| Pubkey::new_unique()).collect();
        let mut s = set_with(&keys, 2);
        s.vote(&keys[0], 0).unwrap();
        assert_eq!(s.vote(&keys[0], 1).unwrap(), 1);
        assert_eq!(s.vote(&keys[1], 1).unwrap(), 2);
    }

    #[test]
    fn swap_remove_carries_the_vote_with_the_key() {
        let keys: Vec<Pubkey> = (0..3).map(|_| Pubkey::new_unique()).collect();
        let mut s = set_with(&keys, 3);
        s.vote(&keys[2], 1).unwrap();
        s.remove(&keys[0]).unwrap();
        // keys[2] moved into slot 0 and its vote must have moved with it.
        assert_eq!(s.member_index(&keys[2]), Some(0));
        assert_eq!(s.votes[0], 1);
        // Threshold clamped to the shrunken roster.
        assert_eq!(s.threshold, 2);
    }

    #[test]
    fn non_members_cannot_vote() {
        let keys: Vec<Pubkey> = (0..2).map(|_| Pubkey::new_unique()).collect();
        let mut s = set_with(&keys, 2);
        assert_eq!(
            s.vote(&Pubkey::new_unique(), 1),
            Err(AttestorSetError::NotFound)
        );
    }
}
