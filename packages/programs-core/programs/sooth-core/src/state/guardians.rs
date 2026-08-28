//! Guardian set — many eyes on the veto, instead of one key.
//!
//! The entry's single `dispute_authority` is a single point of capture: one
//! leaked key and the veto is an attacker's. This side PDA lets that
//! authority deputize up to five guardians — a team multisig's members, an
//! independent watchdog, a bot — any of whom may raise the veto. It is a
//! separate account because the entry has one reserved byte left; append-only
//! ABI means growth happens beside existing accounts, never inside them.
//!
//! Membership is managed by the entry's `dispute_authority`, who remains a
//! valid disputer with or without this account existing.

use anchor_lang::prelude::*;

pub const GUARDIAN_SET_SEED: &[u8] = b"guardians";
pub const MAX_GUARDIANS: usize = 5;

#[account]
pub struct GuardianSet {
    pub market: Pubkey,
    /// Fixed-capacity roster; only the first `count` slots are meaningful.
    pub guardians: [Pubkey; MAX_GUARDIANS],
    pub count: u8,
    pub bump: u8,
}

impl GuardianSet {
    pub const SIZE: usize = 8 + 32 + 32 * MAX_GUARDIANS + 1 + 1;

    pub fn contains(&self, key: &Pubkey) -> bool {
        self.guardians[..self.count as usize].contains(key)
    }

    pub fn add(&mut self, key: Pubkey) -> std::result::Result<(), GuardianSetError> {
        if self.contains(&key) {
            return Err(GuardianSetError::AlreadyPresent);
        }
        if (self.count as usize) >= MAX_GUARDIANS {
            return Err(GuardianSetError::Full);
        }
        self.guardians[self.count as usize] = key;
        self.count += 1;
        Ok(())
    }

    pub fn remove(&mut self, key: &Pubkey) -> std::result::Result<(), GuardianSetError> {
        let idx = self.guardians[..self.count as usize]
            .iter()
            .position(|g| g == key)
            .ok_or(GuardianSetError::NotFound)?;
        // Swap-remove keeps the roster dense so `contains` stays a prefix scan.
        let last = self.count as usize - 1;
        self.guardians[idx] = self.guardians[last];
        self.guardians[last] = Pubkey::default();
        self.count -= 1;
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum GuardianSetError {
    AlreadyPresent,
    Full,
    NotFound,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty() -> GuardianSet {
        GuardianSet {
            market: Pubkey::new_unique(),
            guardians: [Pubkey::default(); MAX_GUARDIANS],
            count: 0,
            bump: 0,
        }
    }

    #[test]
    fn add_contains_remove_roundtrip() {
        let mut set = empty();
        let g = Pubkey::new_unique();
        set.add(g).unwrap();
        assert!(set.contains(&g));
        assert_eq!(set.add(g), Err(GuardianSetError::AlreadyPresent));
        set.remove(&g).unwrap();
        assert!(!set.contains(&g));
        assert_eq!(set.remove(&g), Err(GuardianSetError::NotFound));
    }

    #[test]
    fn capacity_is_enforced_and_swap_remove_keeps_the_roster_dense() {
        let mut set = empty();
        let keys: Vec<Pubkey> = (0..MAX_GUARDIANS).map(|_| Pubkey::new_unique()).collect();
        for k in &keys {
            set.add(*k).unwrap();
        }
        assert_eq!(set.add(Pubkey::new_unique()), Err(GuardianSetError::Full));
        set.remove(&keys[0]).unwrap();
        // The last key moved into slot 0; everyone still present is findable.
        for k in &keys[1..] {
            assert!(set.contains(k));
        }
        assert_eq!(set.count as usize, MAX_GUARDIANS - 1);
    }
}
