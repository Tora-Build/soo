//! Orderbook: a single per-market account holding both sides.
//!
//! See `docs/design/orderbook-redesign.md`. This module is pure data
//! structure — no instructions, no accounts, no CPI — so it can be exercised by
//! ordinary `cargo test` without an SVM; the instructions that drive it live
//! in `instructions/book_*`.

pub mod account;
pub mod arena;
pub mod matcher;
pub mod settlement;

pub use account::*;
pub use arena::*;
pub use matcher::*;
pub use settlement::*;
