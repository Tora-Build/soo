//! Trustless adjudication from Primus zkTLS attestations.
//!
//! `attest_outcome_zk` replaces the human in the manual `attest_outcome` path
//! with a signature check: an attestor observed a TLS response, signed what it
//! saw, and the program re-derives the outcome from those signed bytes.
//!
//! What it deliberately does NOT do is settle. The veto window and the
//! permissionless `settle` remain the only finalization path, so a verifier
//! that is ever wrong is still catchable by `dispute` — the trust removed here
//! is the attester's, not the guardian's.

pub mod primus;
pub mod value;
pub mod verify;

pub use primus::*;
pub use value::*;
pub use verify::*;
