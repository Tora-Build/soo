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

    #[msg("Adjudicator pubkey must not be the default (all-zero) key")]
    AdjudicatorIsDefault,

    #[msg("Adjudicator pubkey is not present on the on-chain allowlist")]
    AdjudicatorNotAllowlisted,

    #[msg("Caller is not the registered allowlist authority")]
    AllowlistAuthorityMismatch,

    #[msg("Adjudicator allowlist is full (capacity exhausted)")]
    AllowlistFull,

    #[msg("Adjudicator pubkey is already present on the allowlist")]
    AdjudicatorAlreadyAllowlisted,

    #[msg("Adjudicator pubkey is not present on the allowlist")]
    AdjudicatorNotPresent,

    #[msg("Helper ixs must be CPI'd from sooth_amm; direct calls are rejected.")]
    InvalidParentInstruction,

    #[msg("Market is not dismissed")]
    MarketNotDismissed,

    #[msg("Invalid instructions sysvar account")]
    InvalidSysvar,

    #[msg("Trading window has closed (now >= deadline)")]
    TradingClosed,

    #[msg("Invalid tick")]
    InvalidTick,

    #[msg("Amount too small for base token decimals")]
    AmountTooSmallForBaseTokenDecimals,
}
