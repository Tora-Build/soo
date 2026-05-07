//! Instruction handlers for `sooth_launchpad`.
//!
//! Each submodule exposes its own `handler` function plus an Accounts struct.
//! Anchor's `#[program]` macro requires the auto-generated
//! `__client_accounts_*` and `__cpi_client_accounts_*` modules from each
//! `#[derive(Accounts)]` to be reachable at `crate::*`, so we glob re-export.
//! The trivially-named `handler` symbol from each module clashes; we silence
//! the warning since the actual `handler` is always called via the explicit
//! `instructions::<module>::handler` path in `lib.rs`.

#![allow(ambiguous_glob_reexports)]

pub mod create_market;
pub mod distribute_fees;
pub mod initialize_fee_pool;
pub mod initialize_protocol;
pub mod mint_lp_for_buy;
pub mod seed_lp;

pub use create_market::*;
pub use distribute_fees::*;
pub use initialize_fee_pool::*;
pub use initialize_protocol::*;
pub use mint_lp_for_buy::*;
pub use seed_lp::*;
