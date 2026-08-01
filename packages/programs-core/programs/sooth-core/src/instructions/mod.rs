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
pub mod book_init;
pub mod book_ops;
pub mod book_place;
pub mod buy;
pub mod cancel;
pub mod cancel_by_id;
pub mod claim_refund;
pub mod claim_unlocked;
pub mod close_book_side;
pub mod compact_book_side;
pub mod create_market;
pub mod dismiss_market;
pub mod dispute;
pub mod distribute_fees;
pub mod distribute_fees_legacy;
pub mod fill_order_internal;
pub mod init_market_fee_pool;
pub mod initialize_amm_state;
pub mod initialize_protocol;
pub mod lock_for_resolution;
pub mod merge_complete_set;
pub mod merge_complete_set_for_orderbook;
pub mod mint_complete_set;
pub mod mint_complete_set_for_orderbook;
pub mod mint_complete_set_to_program_owned;
pub mod orderbook_common;
pub mod pause;
pub mod redeem;
pub mod redeem_from_program_owned;
pub mod redeem_lp;
pub mod redeem_amm_position;
pub mod redeem_orderbook;
pub mod register_adjudicator;
pub mod request_lock;
pub mod seed_lp;
pub mod sell_positions;
pub mod settle;
pub mod trade_positions;
pub mod unpause;

pub use attest_outcome::*;
pub use book_init::*;
pub use book_ops::*;
pub use book_place::*;
pub use buy::*;
pub use cancel::*;
pub use cancel_by_id::*;
pub use claim_refund::*;
pub use claim_unlocked::*;
pub use close_book_side::*;
pub use compact_book_side::*;
pub use create_market::*;
pub use dismiss_market::*;
pub use dispute::*;
pub use distribute_fees::*;
pub use distribute_fees_legacy::*;
pub use fill_order_internal::*;
pub use init_market_fee_pool::*;
pub use initialize_amm_state::*;
pub use initialize_protocol::*;
pub use lock_for_resolution::*;
pub use merge_complete_set::*;
pub use merge_complete_set_for_orderbook::*;
pub use mint_complete_set::*;
pub use mint_complete_set_for_orderbook::*;
pub use mint_complete_set_to_program_owned::*;
pub use pause::*;
pub use redeem::*;
pub use redeem_from_program_owned::*;
pub use redeem_lp::*;
pub use redeem_amm_position::*;
pub use redeem_orderbook::*;
pub use register_adjudicator::*;
pub use request_lock::*;
pub use seed_lp::*;
pub use sell_positions::*;
pub use settle::*;
pub use trade_positions::*;
pub use unpause::*;
