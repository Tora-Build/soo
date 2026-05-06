//! `Market` account. Architecture §2.2.
//!
//! Note: in the canonical 5-program layout this account is **owned by**
//! `sooth_market`, not by `sooth_amm`. We declare it here as a read-only
//! `Account<Market>` for `sooth_amm` instructions to validate lifecycle state
//! (e.g. `is_live()` gating). Once `sooth_market` exists this struct will be
//! re-exported from there or moved to a shared `sooth-protocol-types` crate.

use anchor_lang::prelude::*;

#[account]
pub struct Market {
    /// Deterministic id derived from `keccak256(question || creator || nonce)`,
    /// truncated to 16 bytes per architecture §2.2.
    pub market_id: [u8; 16],

    pub creator: Pubkey,
    pub adjudicator_program: Pubkey,
    pub question_hash: [u8; 32],

    pub start_time: i64,
    pub deadline: i64,

    /// Lifecycle state. Mirrors EVM `MarketState` enum.
    pub state: MarketState,

    /// Resolved outcome, valid only when `state >= Resolved`.
    /// 0 = NO, 1 = YES, 2 = INVALID per protocol-wide OUTCOME encoding.
    pub outcome: u8,

    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketState {
    Live,
    Resolved,
    Attested,
    Settled,
    Dismissed,
}

impl Market {
    /// Borsh-serialized size for rent calculation. Anchor's 8-byte
    /// discriminator is added by `#[account]`. Update if fields change.
    pub const SPACE: usize = 8   // discriminator
        + 16                     // market_id
        + 32                     // creator
        + 32                     // adjudicator_program
        + 32                     // question_hash
        + 8                      // start_time
        + 8                      // deadline
        + 1 + 1                  // state (enum tag + max variant)
        + 1                      // outcome
        + 1;                     // bump

    pub fn is_live(&self) -> bool {
        matches!(self.state, MarketState::Live)
    }
}
