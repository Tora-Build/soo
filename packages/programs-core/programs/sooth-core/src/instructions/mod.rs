//! Instruction handlers for `sooth_core`.
//!
//! Each submodule exposes its own `handler` function plus an Accounts struct.
//! Anchor's `#[program]` macro requires the auto-generated
//! `__client_accounts_*` and `__cpi_client_accounts_*` modules from each
//! `#[derive(Accounts)]` to be reachable at `crate::*`, so we glob re-export.
//! The trivially-named `handler` symbol from each module clashes; we silence
//! the warning since the actual `handler` is always called via the explicit
//! `instructions::<module>::handler` path in `lib.rs`.

#![allow(ambiguous_glob_reexports)]

pub mod attest_outcome;
pub mod attest_outcome_zk;
pub mod book_init;
pub mod book_ops;
pub mod book_place;
pub mod claim_refund;
pub mod close_market;
pub mod claim_unlocked;
pub mod create_market;
pub mod dismiss_market;
pub mod dispute;
pub mod distribute_fees;
pub mod distribute_fees_book;
pub mod init_market_fee_pool;
pub mod initialize_protocol;
pub mod lock_for_resolution;
pub mod pause;
pub mod redeem_lp;
pub mod reclaim_subsidy;
pub mod redeem_amm_position;
pub mod redeem_book_seat;
pub mod register_adjudicator;
pub mod register_zk_adjudicator;
pub mod request_lock;
pub mod seed_lp;
pub mod sell_positions;
pub mod settle;
pub mod sweep_residual;
pub mod trade_positions;
pub mod unpause;

pub use attest_outcome::*;
pub use attest_outcome_zk::*;
pub use book_init::*;
pub use book_ops::*;
pub use book_place::*;
pub use claim_refund::*;
pub use close_market::*;
pub use claim_unlocked::*;
pub use create_market::*;
pub use dismiss_market::*;
pub use dispute::*;
pub use distribute_fees::*;
pub use distribute_fees_book::*;
pub use init_market_fee_pool::*;
pub use initialize_protocol::*;
pub use lock_for_resolution::*;
pub use pause::*;
pub use redeem_lp::*;
pub use reclaim_subsidy::*;
pub use redeem_amm_position::*;
pub use redeem_book_seat::*;
pub use register_adjudicator::*;
pub use register_zk_adjudicator::*;
pub use request_lock::*;
pub use seed_lp::*;
pub use sell_positions::*;
pub use settle::*;
pub use sweep_residual::*;
pub use trade_positions::*;
pub use unpause::*;
