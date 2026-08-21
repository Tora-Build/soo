//! Math utilities for `sooth_core`.
//!
//! - `book`  — WAD↔base-unit conversion shared by the AMM settlement paths.
//! - `lmsr`  — LMSR cost function (exp_wad, ln_wad, cost_delta).
//! - `wad`   — WAD (1e18) fixed-point primitives.

pub mod book;
pub mod lmsr;
pub mod wad;

pub use book::{wad_to_base, BASE_UNIT_WAD};
pub use lmsr::{cost_delta, lmsr_cost};
pub use wad::{
    wad_div, wad_mul, wad_to_usdc_ceil, wad_to_usdc_floor, MathError, LN2_WAD, WAD,
    WAD_TO_USDC_SCALAR, WAD_U,
};
