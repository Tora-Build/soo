//! Redesigned orderbook: a single per-market account holding both sides.
//!
//! Phase 1 of `docs/design/orderbook-redesign.md`. This module is pure data
//! structure — no instructions, no accounts, no CPI — so it can be exercised by
//! ordinary `cargo test` without an SVM. Wiring it up is Phase 3.
//!
//! The existing `state/book_side.rs` + `matching.rs` book remains live and
//! untouched until then.

pub mod account;
pub mod arena;
pub mod settlement;

pub use account::*;
pub use arena::*;
pub use settlement::*;
