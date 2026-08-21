//! Error codes for the T\* voiding path.
//!
//! A separate enum with its own `offset` rather than new variants on
//! `SoothCoreError`. Two reasons, and the first is the binding one:
//!
//!   - `SoothCoreError`'s discriminants are the wire format — Anchor numbers
//!     them positionally from 6000 and every deployed client maps the NUMBER
//!     back to a name. A second enum based at 7000 cannot renumber the first
//!     one no matter how it grows.
//!   - Voiding is one self-contained subsystem, and an error range that says
//!     so is worth having when a 7xxx code shows up in a log.
//!
//! The same append-only rule applies inside this enum once it ships.

use anchor_lang::prelude::*;

#[error_code(offset = 1000)]
pub enum ResolutionError {
    #[msg("T* must lie between the market's start and the attestation")]
    InvalidTStar,

    #[msg("A resolution commitment must carry at least one leaf")]
    EmptyCommitment,

    #[msg("Merkle root must be non-zero")]
    ZeroMerkleRoot,

    #[msg("This market already has a resolution commitment")]
    CommitmentAlreadyPublished,

    #[msg("This market has a resolution commitment; a voided claim is required")]
    VoidedClaimRequired,

    #[msg("This market has no resolution commitment; no voided claim is accepted")]
    UnexpectedVoidedClaim,

    #[msg("Resolution commitment does not belong to this market")]
    CommitmentMarketMismatch,

    #[msg("Merkle proof does not prove this leaf against the published root")]
    InvalidMerkleProof,

    #[msg("Merkle proof is longer than the protocol accepts")]
    MerkleProofTooLong,

    #[msg("Entitled shares exceed the shares the position actually holds")]
    EntitlementExceedsPosition,

    #[msg("Void refund exceeds what this position paid in")]
    VoidRefundExceedsCost,

    #[msg("Void refund exceeds the published total for this market")]
    VoidRefundExceedsPublishedTotal,

    #[msg("Resolution commitment account is not owned by sooth_core")]
    CommitmentOwnerMismatch,

    #[msg("The abandonment timeout has not elapsed; this market may not be forced to INVALID")]
    AbandonmentTimeoutNotElapsed,

    #[msg("Book net entitlement exceeds the net this seat actually holds")]
    EntitlementExceedsSeat,

    #[msg("Book void refund exceeds the value of the voided fills")]
    BookVoidRefundExceedsVoidedValue,

    #[msg("Book void refund exceeds the published book total for this market")]
    BookVoidRefundExceedsPublishedTotal,

    #[msg("The vault does not cover the refunds and payouts this commitment claims")]
    CommitmentExceedsVault,
}
