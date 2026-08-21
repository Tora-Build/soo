//! Math utilities for `sooth_core`.
//!
//! - `book`  — tick constants and helpers for the CLOB orderbook.
//! - `lmsr`  — LMSR cost function (exp_wad, ln_wad, cost_delta).
//! - `wad`   — WAD (1e18) fixed-point primitives.

pub mod book;
pub mod lmsr;
pub mod wad;

pub use book::{
    min_resting_order_for_tick, resting_cost_base, tick_cost_wad, wad_to_base, BASE_UNIT_WAD,
    MAX_TICK, MIN_TICK, NUM_TICKS,
};
pub use lmsr::{cost_delta, lmsr_cost};
pub use wad::{
    wad_div, wad_mul, wad_to_usdc_ceil, wad_to_usdc_floor, MathError, LN2_WAD, WAD,
    WAD_TO_USDC_SCALAR, WAD_U,
};
