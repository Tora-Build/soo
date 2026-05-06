//! Fixed-point math for the LMSR cost function.
//!
//! Layout:
//!   - `wad`  : `wad_mul`, `wad_div`, the WAD/USDC scalar conversions
//!   - `lmsr` : `exp_wad`, `ln_wad`, `cost_delta` (the log-sum-exp shifted
//!              difference C(q+Δ) - C(q) used by `trade_positions`)
//!
//! All ported verbatim from `_spikes/lmsr-cu/src/math.rs` and `lib.rs` per
//! decision D4 (Taylor exact at WAD precision, no LUT). The spike's variant B
//! (LUT approximation) is **not** carried forward — D4 explicitly drops it
//! from the production critical path.

pub mod lmsr;
pub mod wad;

pub use lmsr::{cost_delta, exp_wad, ln_wad, lmsr_cost, MathError};
pub use wad::{wad_div, wad_mul, wad_to_usdc_ceil, LN2_WAD, WAD, WAD_U};
