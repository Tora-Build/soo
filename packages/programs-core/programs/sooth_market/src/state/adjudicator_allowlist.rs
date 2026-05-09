//! `AdjudicatorAllowlist` — singleton on-chain registry of pubkeys permitted
//! to be passed as the `adjudicator` field on `initialize_market`.
//!
//! ## Why this exists
//!
//! The v1 lifecycle ixs (`lock_for_resolution`, `settle`) gate on
//! `adjudicator: Signer` whose key equals `market.adjudicator`. That field is
//! taken verbatim from `InitializeMarketArgs` — meaning any creator can name
//! any pubkey (including their own) as the adjudicator and then settle the
//! market themselves. Codex's 2nd-pass review flagged this as the principal
//! C2 attack surface and the recommended **minimum-viable** mitigation is:
//!
//! > "Reject default and enforce an on-chain allowlist/registry for
//! > adjudicator signers at market creation."
//!
//! This account is that allowlist. It is checked at `initialize_market` time
//! only; the lifecycle ixs are unchanged in this commit. By constraining the
//! *set of valid adjudicators* at market-creation, we shrink the attack
//! surface from "anyone with a keypair" to "the protocol-curated set of
//! adjudicator pubkeys".
//!
//! ## Authority model
//!
//! A single `authority: Pubkey` field controls add/remove. This is initialised
//! via the one-shot `initialize_adjudicator_allowlist` ix and is intended to
//! point at the protocol multisig / governance program. Rotating the
//! authority is out of scope for this minimum-viable mitigation — the long-
//! term home for this logic is a real `sooth_adjudicator` program (see
//! migration note below).
//!
//! ## Capacity
//!
//! Fixed-size array of 16 entries. Rationale: the protocol is launching with
//! a curated adjudicator set well below this bound (manual + zk-tls + a few
//! oracle slots, see `apps/demo/src/config/registries.ts`), and a fixed array
//! keeps the account a flat, predictable rent-exempt size that costs ~600
//! bytes — cheap enough to preallocate at deploy time rather than `realloc`
//! lazily. If the protocol ever needs more than 16 adjudicators, that is the
//! signal that the full `sooth_adjudicator` program (with a real registry
//! account per adjudicator) should land instead of widening this allowlist.
//!
//! ## Future migration
//!
//! When the full `sooth_adjudicator` program scaffolds, `initialize_market`
//! switches from "check pubkey against this allowlist" to "verify CPI parent
//! is the adjudicator program AND that program's per-adjudicator account
//! authorises this market". This file becomes either deprecated or repurposed
//! as a fallback for the manual-adjudicator path. Tracked as a follow-up to
//! the Codex C2 finding.

use anchor_lang::prelude::*;

/// Maximum number of adjudicator pubkeys the protocol will allow-list under
/// the v1 minimum-viable mitigation. See module-level capacity rationale.
pub const ADJUDICATOR_ALLOWLIST_CAPACITY: usize = 16;

/// PDA seed for the singleton allowlist account.
pub const ADJUDICATOR_ALLOWLIST_SEED: &[u8] = b"adjudicator_allowlist";

#[account]
pub struct AdjudicatorAllowlist {
    /// Authority permitted to call `add_adjudicator` / `remove_adjudicator`.
    /// Set once at `initialize_adjudicator_allowlist` time. Intended to be
    /// the protocol multisig.
    pub authority: Pubkey,
    /// Fixed-size pubkey table. Slots beyond `entry_count` are guaranteed
    /// zero (we never leave stale data behind on remove — see
    /// `remove_adjudicator`).
    pub entries: [Pubkey; ADJUDICATOR_ALLOWLIST_CAPACITY],
    /// Number of populated slots in `entries` (0..=ADJUDICATOR_ALLOWLIST_CAPACITY).
    pub entry_count: u8,
    /// Bump for the singleton PDA.
    pub bump: u8,
}

impl AdjudicatorAllowlist {
    /// Borsh-serialized size for rent calculation. Anchor's 8-byte
    /// discriminator is added by `#[account]`. Update if fields change.
    pub const SPACE: usize = 8     // discriminator
        + 32                       // authority
        + 32 * ADJUDICATOR_ALLOWLIST_CAPACITY // entries
        + 1                        // entry_count
        + 1; // bump

    /// True iff `candidate` is currently allow-listed. Linear scan; capacity
    /// is bounded at 16 so this is O(16) worst-case which is negligible
    /// compared to the surrounding ix overhead.
    pub fn contains(&self, candidate: Pubkey) -> bool {
        let count = self.entry_count as usize;
        if count > ADJUDICATOR_ALLOWLIST_CAPACITY {
            return false;
        }
        self.entries[..count].contains(&candidate)
    }
}
