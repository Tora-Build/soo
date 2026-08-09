//! `Market` PDA — lifecycle, outcome, and per-market configuration.

use anchor_lang::prelude::*;

use crate::state::lifecycle::MarketLifecycle;

/// Protocol-wide outcome encoding. 0=NO, 1=YES, 2=INVALID.
pub const OUTCOME_NO: u8 = 0;
pub const OUTCOME_YES: u8 = 1;
pub const OUTCOME_INVALID: u8 = 2;

#[account]
pub struct Market {
    /// Deterministic 16-byte id (truncated keccak256 of question || creator
    /// || nonce). Architecture §2.2.
    pub market_id: [u8; 16],
    pub creator: Pubkey,
    /// The adjudicator pubkey recorded at `initialize_market` time. The
    /// adjudicator is also registered as an `AdjudicatorEntry` PDA. This
    /// field remains the canonical source of truth for the market's
    /// designated adjudicator identity.
    pub adjudicator: Pubkey,
    pub question_hash: [u8; 32],
    /// USDC vault ATA — populated by `initialize_market_vaults`.
    pub vault: Pubkey,
    /// AMM lock-on-sell escrow vault — populated by `initialize_market_vaults`.
    pub lock_vault: Pubkey,
    pub start_time: i64,
    pub deadline: i64,
    pub lifecycle: MarketLifecycle,
    /// Set by `settle`. 0=NO, 1=YES, 2=INVALID (only meaningful when
    /// lifecycle == Settled).
    pub winning_outcome: u8,
    /// PDA bumps stored at `initialize_market` time.
    pub bump: u8,
    pub vault_authority_bump: u8,
    pub lock_authority_bump: u8,

    /// Forward-compat padding. Adding a field consumes bytes from here
    /// instead of changing the account's length, so no migration is needed:
    /// Solana accounts are fixed-length buffers, and an `#[account]` struct
    /// that outgrows its buffer fails to deserialize on every instruction
    /// that loads it. (Unlike EVM, where appending a storage slot is free.)
    ///
    /// When you add a field, shrink this by exactly its serialized size and
    /// leave `SPACE` unchanged.
    pub _reserved: [u8; 130],
}

impl Market {
    /// Seeds: `[b"market", market_id]` under `sooth_core::ID`.
    pub const SPACE: usize = 8      // discriminator
        + 16                         // market_id
        + 32                         // creator
        + 32                         // adjudicator
        + 32                         // question_hash
        + 32                         // vault
        + 32                         // lock_vault
        + 8                          // start_time
        + 8                          // deadline
        + 1                          // lifecycle (Borsh enum tag)
        + 1                          // winning_outcome
        + 1                          // bump
        + 1                          // vault_authority_bump
        + 1                          // lock_authority_bump
        + 130; // _reserved

    pub fn is_open(&self) -> bool {
        matches!(self.lifecycle, MarketLifecycle::Open)
    }

    pub fn is_locked(&self) -> bool {
        matches!(self.lifecycle, MarketLifecycle::Locked)
    }

    pub fn is_settled(&self) -> bool {
        matches!(self.lifecycle, MarketLifecycle::Settled)
    }
}
