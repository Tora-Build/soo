//! Instruction handlers for `sooth_market`.
//!
//! Each submodule exposes its own `handler` function plus an Accounts struct.
//! Anchor's `#[program]` macro requires the auto-generated
//! `__client_accounts_*` and `__cpi_client_accounts_*` modules from each
//! `#[derive(Accounts)]` to be reachable at `crate::*`, so we glob re-export.
//! The trivially-named `handler` symbol from each module clashes; we silence
//! the warning since the actual `handler` is always called via the explicit
//! `instructions::<module>::handler` path in `lib.rs`.

#![allow(ambiguous_glob_reexports)]

pub mod add_adjudicator;
pub mod initialize_adjudicator_allowlist;
pub mod initialize_market;
pub mod initialize_market_vaults;
pub mod initialize_outcome_mints;
pub mod lock_for_resolution;
pub mod merge_complete_set;
pub mod mint_complete_set;
pub mod redeem;
pub mod remove_adjudicator;
pub mod settle;

pub use add_adjudicator::*;
pub use initialize_adjudicator_allowlist::*;
pub use initialize_market::*;
pub use initialize_market_vaults::*;
pub use initialize_outcome_mints::*;
pub use lock_for_resolution::*;
pub use merge_complete_set::*;
pub use mint_complete_set::*;
pub use redeem::*;
pub use remove_adjudicator::*;
pub use settle::*;
