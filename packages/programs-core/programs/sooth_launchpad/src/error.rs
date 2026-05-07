//! Error codes for `sooth_launchpad`.
//!
//! Discriminants ordered by likelihood-of-occurrence so the most common errors
//! get short instruction-data encodings. Don't reorder once we ship.

use anchor_lang::prelude::*;

#[error_code]
pub enum SoothLaunchpadError {
    #[msg("Caller is not the registered protocol authority")]
    Unauthorized,

    #[msg("Fee bps must not exceed 10000 (100%)")]
    FeeBpsOutOfRange,

    #[msg("Fee split bps do not sum to 10000")]
    FeeSplitMismatch,

    #[msg("Treasury pubkey must be non-default")]
    InvalidTreasury,

    #[msg("Default trial period must be > 0")]
    InvalidTrialPeriod,

    #[msg("Market is already graduated; LP-mint flow disabled")]
    AlreadyGraduated,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Protocol config already initialized")]
    AlreadyInitialized,

    #[msg("Fee pool is empty — nothing to distribute")]
    NothingToDistribute,
}
