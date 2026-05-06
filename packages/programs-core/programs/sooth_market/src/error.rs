//! Error codes for `sooth_market`.
//!
//! Discriminants ordered by likelihood-of-occurrence so the most common errors
//! get short instruction-data encodings. Don't reorder once we ship.

use anchor_lang::prelude::*;

#[error_code]
pub enum SoothMarketError {
    #[msg("Market is not in the Open lifecycle state")]
    MarketNotOpen,

    #[msg("Market is not in the Locked lifecycle state")]
    MarketNotLocked,

    #[msg("Market is not Settled")]
    MarketNotSettled,

    #[msg("Lifecycle transition not permitted from current state")]
    InvalidLifecycleTransition,

    #[msg("Caller is not the registered adjudicator for this market")]
    NotAdjudicator,

    #[msg("Invalid outcome (must be NO=0, YES=1, or INVALID=2)")]
    InvalidOutcome,

    #[msg("Amount must be non-zero")]
    ZeroAmount,

    #[msg("Insufficient outcome-token balance")]
    InsufficientOutcomeShares,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Vault / mint authority mismatch")]
    VaultAuthorityMismatch,

    #[msg("Deadline must be greater than start_time")]
    InvalidDeadline,
}
