//! Error codes for `sooth_adjudicator`.
//!
//! Discriminants ordered by likelihood-of-occurrence so the most common errors
//! get short instruction-data encodings. Don't reorder once we ship.

use anchor_lang::prelude::*;

#[error_code]
pub enum SoothAdjudicatorError {
    #[msg("Caller is not the registered authority for this adjudicator")]
    NotAuthority,

    #[msg("Adjudicator kind does not support this operation (e.g. ZkTLS attestation on a Manual adjudicator)")]
    UnsupportedKind,

    #[msg("Adjudicator has already attested an outcome; re-attestation is not permitted")]
    AlreadyAttested,

    #[msg("Adjudicator has not yet attested an outcome")]
    NotAttested,

    #[msg("Invalid outcome (must be NO=0, YES=1, or INVALID=2)")]
    InvalidOutcome,

    #[msg("Adjudicator account does not match the supplied market")]
    MarketMismatch,

    #[msg("Authority pubkey must not be the default (all-zero) key")]
    AuthorityIsDefault,

    #[msg("Dispute path is not implemented in v1; see architecture §4.4")]
    DisputeNotImplemented,

    #[msg("Caller is not the registered dispute authority for this adjudicator")]
    NotDisputeAuthority,

    #[msg("Adjudicator has already been disputed; dispute is one-shot per market")]
    AlreadyDisputed,

    #[msg("Market is already settled; dispute can no longer override the outcome")]
    MarketAlreadySettled,
}
