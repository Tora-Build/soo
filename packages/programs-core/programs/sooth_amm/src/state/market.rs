//! `Market` re-export.
//!
//! The `Market` account is owned by `sooth_market` (architecture §1, §2.2).
//! `sooth_amm` only ever reads it (lifecycle gating in `trade_positions`), so
//! we re-export the canonical type directly from `sooth_market`. This makes
//! Anchor's `Account<'info, Market>` ownership check resolve against
//! `sooth_market::ID` automatically (via the `Owner` trait derived by
//! `#[account]`).
//!
//! Until the previous commit there was a placeholder copy of `Market` here
//! with a divergent layout — that's now removed because cross-program PDA
//! agreement is load-bearing for `seeds::program = sooth_market::ID`.

pub use sooth_market::state::Market;
