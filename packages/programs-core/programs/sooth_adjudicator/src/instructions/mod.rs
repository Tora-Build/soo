//! Instruction handlers for `sooth_adjudicator`.
//!
//! Each submodule exposes its own `handler` function plus an Accounts struct.
//! Anchor's `#[program]` macro requires the auto-generated
//! `__client_accounts_*` and `__cpi_client_accounts_*` modules from each
//! `#[derive(Accounts)]` to be reachable at `crate::*`, so we glob re-export.
//!
//! v1 surface:
//!   - `register_adjudicator` — REAL — creates Adjudicator PDA per market.
//!   - `request_lock`         — REAL — gates `sooth_market::lock_for_resolution`
//!     via CPI, replacing the loose signer-key check.
//!   - `attest_outcome`       — REAL (Manual variant) — authority signs the
//!     resolved outcome, mutates Adjudicator state, then CPIs into
//!     `sooth_market::settle`.
//!   - `dispute`              — STUB — `todo!()` with arch §4.4 ref.

#![allow(ambiguous_glob_reexports)]

pub mod attest_outcome;
pub mod dispute;
pub mod register_adjudicator;
pub mod request_lock;

pub use attest_outcome::*;
pub use dispute::*;
pub use register_adjudicator::*;
pub use request_lock::*;
