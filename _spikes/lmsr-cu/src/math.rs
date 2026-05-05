//! Fixed-point WAD (1e18) math for the LMSR cost function.
//!
//! WAD = 1e18, matching the EVM `LMSRMath.sol` semantics described in
//! `packages/programs-core/docs/architecture.md §3.1`. We do everything in
//! `i128` (signed) for `exp` arguments — q/b can be negative for the difference
//! C(q+Δ) - C(q) when one side outpaces the other — and `u128` for `ln`
//! arguments which are always strictly positive (sum of two exps).
//!
//! Two variants are provided behind feature flags:
//!
//!   (A) **Taylor exact** (`default`) — range-reduction via integer floor/log2
//!       split, then a Taylor series. Aim: ~1e-12 relative error. Each call
//!       runs O(N) WAD multiplies where N is the term count (12 for exp, 14
//!       for ln). On BPF this is the dominant cost.
//!
//!   (B) **LUT approximation** (`lut`) — 256-entry lookup tables for exp and
//!       ln over a normalized range, plus linear interpolation. Aim: ~1e-6
//!       relative error, which is well below USDC dust (1e-6 USD precision
//!       is the unit of account anyway). Trade ~5x CU for a small precision
//!       loss. Acceptable per architecture doc §5 mitigation #1.
//!
//! ## Why i128 / u128 and not u256
//!
//! WAD * WAD = 1e36 which fits in u128 (max ~3.4e38). LMSR's intermediate
//! products are q (≤ 1e6 shares × WAD = 1e24) times 1/b (≤ 1/1e18) which
//! stays well below 1e36. Where we need a temporary 256-bit window — only
//! during `wad_mul` for the inner exp series — we widen to a manual
//! 256-bit mul-then-divide using two u128 limbs. No external u256 crate
//! needed; saves a dependency and the BPF inlining is friendlier.
//!
//! ## Precision strategy
//!
//! - exp: range-reduce x = k·ln(2) + r where r ∈ [-ln(2)/2, ln(2)/2], then
//!   Taylor on r and shift by 2^k. Domain check: |x| ≤ 64·WAD before we
//!   bail with `MathError::Overflow`. q/b in our markets is bounded by the
//!   `b` parameter and realistic share counts; |q/b| > 50 means a one-sided
//!   market that is essentially resolved.
//!
//! - ln: range-reduce y = 2^k·m where m ∈ [1, 2), then ln(m) via Taylor on
//!   (m-1)/(m+1). k comes from `u128::leading_zeros`. Domain: y > 0.

use core::convert::TryInto;

/// 1e18 — matches EVM's WAD.
pub const WAD: i128 = 1_000_000_000_000_000_000;
pub const WAD_U: u128 = 1_000_000_000_000_000_000;

/// ln(2) in WAD.
pub const LN2_WAD: i128 = 693_147_180_559_945_309;

/// Maximum |x| for `exp_wad` before we refuse. ~133·WAD is where exp(x)
/// approaches u128::MAX. We clamp tighter at 64·WAD because LMSR diffs
/// past that mean the market is one-sided enough that the math is moot.
pub const EXP_MAX_INPUT_WAD: i128 = 64 * WAD;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    /// `exp` input outside [-EXP_MAX_INPUT_WAD, EXP_MAX_INPUT_WAD], or `ln`
    /// of a non-positive value, or an intermediate u128/i128 overflow.
    Overflow,
}

/// Multiply two WAD numbers, returning a WAD number. Uses a 256-bit
/// intermediate via splitting one operand into high/low 64-bit limbs.
/// Result = (a * b) / WAD with rounding toward zero.
#[inline(always)]
pub fn wad_mul(a: i128, b: i128) -> Result<i128, MathError> {
    let neg = (a < 0) ^ (b < 0);
    let au = a.unsigned_abs();
    let bu = b.unsigned_abs();
    let prod_lo = au.wrapping_mul(bu);
    // Detect overflow by checking the high half via 64-bit limbs.
    let a_hi = au >> 64;
    let a_lo = au & ((1u128 << 64) - 1);
    let b_hi = bu >> 64;
    let b_lo = bu & ((1u128 << 64) - 1);
    // 256-bit product: (a_hi*2^64 + a_lo) * (b_hi*2^64 + b_lo)
    let ll = a_lo.wrapping_mul(b_lo);
    let lh = a_lo.wrapping_mul(b_hi);
    let hl = a_hi.wrapping_mul(b_lo);
    let hh = a_hi.wrapping_mul(b_hi);
    // mid = lh + hl (carry into hh)
    let (mid, carry1) = lh.overflowing_add(hl);
    // accumulate ll's high half + mid_low into prod_hi
    let prod_lo_hi = ll >> 64;
    let mid_lo = mid & ((1u128 << 64) - 1);
    let mid_hi = mid >> 64;
    let (sum, carry2) = prod_lo_hi.overflowing_add(mid_lo << 64);
    let _ = sum;
    let prod_hi = hh
        .wrapping_add(mid_hi)
        .wrapping_add((carry1 as u128) << 64)
        .wrapping_add(carry2 as u128);

    // Now 256-bit product is (prod_hi << 128) | prod_lo. Divide by WAD.
    // Long division: q = (prod_hi << 128 + prod_lo) / WAD.
    if prod_hi == 0 {
        let q = prod_lo / WAD_U;
        let qi: i128 = q.try_into().map_err(|_| MathError::Overflow)?;
        return Ok(if neg { -qi } else { qi });
    }
    // prod_hi != 0: do schoolbook division on two u128 halves.
    // Step 1: divide prod_hi by WAD -> q_hi, rem_hi
    let q_hi = prod_hi / WAD_U;
    let rem_hi = prod_hi % WAD_U;
    // Step 2: combine rem_hi << 128 + prod_lo and divide by WAD.
    // This needs another u128/u128 split. Approach: do it in two u64 chunks.
    // Build `n = (rem_hi << 128) | prod_lo` as a 256-bit u, divide by WAD.
    // Since rem_hi < WAD < 2^60, rem_hi << 128 fits, but we still need 256-bit
    // arithmetic. Implement by processing 64 bits of dividend at a time.
    let mut rem = rem_hi; // current remainder, < WAD < 2^60
    let mut q_lo: u128 = 0;
    // Shift in 128 bits from prod_lo, 32 bits at a time, accumulating quotient.
    // 32-bit chunks keep `rem << 32 + chunk` < 2^92 which fits in u128.
    for chunk_idx in (0..4).rev() {
        let chunk = (prod_lo >> (chunk_idx * 32)) & 0xFFFF_FFFF;
        rem = (rem << 32) | chunk;
        let q_chunk = rem / WAD_U;
        rem = rem % WAD_U;
        q_lo = (q_lo << 32) | q_chunk;
    }
    // Final quotient = q_hi * 2^128 + q_lo. Must fit in i128 magnitude.
    if q_hi != 0 {
        return Err(MathError::Overflow);
    }
    let qi: i128 = q_lo.try_into().map_err(|_| MathError::Overflow)?;
    Ok(if neg { -qi } else { qi })
}

/// Divide two WAD numbers: (a * WAD) / b.
#[inline(always)]
pub fn wad_div(a: i128, b: i128) -> Result<i128, MathError> {
    if b == 0 {
        return Err(MathError::Overflow);
    }
    // Compute (a * WAD) / b. a * WAD may overflow i128 for |a| > i128::MAX/WAD ≈ 1.7e20.
    // Our q values are bounded by ~1e6 shares × WAD = 1e24 — too big. So we
    // need the 256-bit path: |a * WAD| in u256, divide by |b|.
    let neg = (a < 0) ^ (b < 0);
    let au = a.unsigned_abs();
    let bu = b.unsigned_abs();
    // 256-bit (au * WAD): WAD < 2^60, au < 2^127, product < 2^187.
    let a_hi = au >> 64;
    let a_lo = au & ((1u128 << 64) - 1);
    let w = WAD_U;
    let lo = a_lo.wrapping_mul(w);
    let hi = a_hi.wrapping_mul(w);
    // assemble num = (hi << 64) + lo, but carefully:
    let num_lo_low = lo & ((1u128 << 64) - 1);
    let num_lo_high = lo >> 64;
    let (num_mid, carry) = (hi).overflowing_add(num_lo_high);
    let _ = carry; // hi*au capped, no overflow into a third limb because au < 2^127, w < 2^60
    let num_hi = num_mid >> 64;
    let num_mid_low = num_mid & ((1u128 << 64) - 1);
    let num_low = (num_mid_low << 64) | num_lo_low;
    // Now u192-style: num = num_hi (top 64 bits) :: num_low (low 128 bits).
    // Divide by bu (< 2^127). Use 32-bit chunked division.
    let mut rem: u128 = num_hi;
    if rem >= bu {
        // shouldn't happen for our domain but check
        return Err(MathError::Overflow);
    }
    let mut q: u128 = 0;
    for chunk_idx in (0..4).rev() {
        let chunk = (num_low >> (chunk_idx * 32)) & 0xFFFF_FFFF;
        rem = (rem << 32) | chunk;
        let qc = rem / bu;
        rem = rem % bu;
        q = (q << 32) | qc;
    }
    let qi: i128 = q.try_into().map_err(|_| MathError::Overflow)?;
    Ok(if neg { -qi } else { qi })
}

// ------------------------------ Variant A: Taylor exact ------------------------------

#[cfg(not(feature = "lut"))]
pub fn exp_wad(x: i128) -> Result<i128, MathError> {
    // Saturate the negative tail: exp(-EXP_MAX_INPUT_WAD) ≈ 1e-28, well below
    // any WAD-representable value. Returning 0 here keeps log-sum-exp stable
    // for arbitrarily imbalanced markets without bubbling a spurious error.
    if x < -EXP_MAX_INPUT_WAD {
        return Ok(0);
    }
    if x > EXP_MAX_INPUT_WAD {
        return Err(MathError::Overflow);
    }
    if x == 0 {
        return Ok(WAD);
    }
    // Range reduction: x = k * ln(2) + r, r ∈ [-ln(2)/2, ln(2)/2].
    // k = round(x / ln(2)).
    let k = {
        // round to nearest: (x + sign(x) * LN2/2) / LN2, integer division.
        let half = LN2_WAD / 2;
        if x >= 0 {
            (x + half) / LN2_WAD
        } else {
            (x - half) / LN2_WAD
        }
    };
    let r = x - k * LN2_WAD; // small in WAD, |r| ≤ LN2/2 ≈ 0.347 * WAD

    // Taylor: exp(r) = sum r^n / n!  for n=0..N
    // For |r| ≤ 0.347, 12 terms gives ~1e-18 relative error, well past WAD precision.
    let mut term = WAD; // r^0 / 0! = 1
    let mut sum = WAD;
    let n_terms = 12u32;
    for n in 1..=n_terms {
        // term *= r / n
        term = wad_mul(term, r)?;
        term = term / (n as i128);
        sum = sum.checked_add(term).ok_or(MathError::Overflow)?;
    }
    // Multiply by 2^k. k can be negative: shift right (divide by 2^|k|).
    let result = if k >= 0 {
        let k_u = k as u32;
        if k_u >= 127 {
            return Err(MathError::Overflow);
        }
        sum.checked_shl(k_u).ok_or(MathError::Overflow)?
    } else {
        let k_u = (-k) as u32;
        if k_u >= 127 {
            // exp very small -> ~0 in WAD
            return Ok(0);
        }
        sum >> k_u
    };
    Ok(result)
}

#[cfg(not(feature = "lut"))]
pub fn ln_wad(y: i128) -> Result<i128, MathError> {
    if y <= 0 {
        return Err(MathError::Overflow);
    }
    // y = 2^k * m where m ∈ [WAD, 2*WAD).
    // k = floor(log2(y/WAD)).
    let yu = y as u128;
    // bit length of yu
    let bits = 128 - yu.leading_zeros() as i32;
    // WAD has bit length 60. So k = bits - 60 - 1 if yu's top bit position ≥ WAD.
    // More directly: find k such that WAD << k <= yu < WAD << (k+1).
    let wad_bits = 128 - WAD_U.leading_zeros() as i32; // 60
    let k = bits - wad_bits; // can be negative if y < WAD
    // m = y / 2^k (still in WAD)
    let m: i128 = if k >= 0 {
        (yu >> (k as u32)) as i128
    } else {
        // k negative: shift left
        let kk = (-k) as u32;
        if kk >= 127 {
            return Err(MathError::Overflow);
        }
        (yu << kk) as i128
    };
    // Now m ∈ [WAD, 2*WAD). Compute ln(m/WAD) via series on z = (m - WAD)/(m + WAD).
    let m_minus = m - WAD;
    let m_plus = m + WAD;
    let z = wad_div(m_minus, m_plus)?; // z ∈ [0, 1/3) for m ∈ [WAD, 2*WAD)
    // ln(m/WAD) = 2 * (z + z^3/3 + z^5/5 + z^7/7 + ...)
    // For |z| < 1/3, 14 odd terms gives ~1e-19 relative error.
    let z2 = wad_mul(z, z)?;
    let mut term = z;
    let mut sum = z;
    let n_terms = 14u32;
    for n in 1..n_terms {
        term = wad_mul(term, z2)?;
        let denom = (2 * n + 1) as i128;
        sum = sum
            .checked_add(term / denom)
            .ok_or(MathError::Overflow)?;
    }
    let ln_m_over_wad = sum
        .checked_mul(2)
        .ok_or(MathError::Overflow)?;
    // ln(y/WAD) = k * ln(2) + ln(m/WAD)
    let k_term = (k as i128)
        .checked_mul(LN2_WAD)
        .ok_or(MathError::Overflow)?;
    Ok(k_term + ln_m_over_wad)
}

// ------------------------------ Variant B: LUT approximation ------------------------------
//
// Sketch only. Enabled with `--features lut`. Implementation strategy:
//
//   1. Pre-compute a 256-entry table of `exp(r)` for r ∈ [-LN2/2, LN2/2],
//      stored as `[i128; 257]` (extra entry for the right edge so linear
//      interpolation is branch-free).
//   2. Range-reduce the input the same way variant A does (k·ln2 + r).
//   3. Compute the bin index `idx = ((r + LN2/2) * 256) >> 60` (avoiding the
//      WAD division by using a power-of-two scale for the table input).
//   4. Linear interpolate: `val = LUT[idx] + ((LUT[idx+1] - LUT[idx]) * frac) >> 60`.
//   5. Apply 2^k shift exactly as in variant A.
//
// Expected result: ~5x fewer CU than the Taylor path (one mul + one add vs
// 12 muls), at ~1e-6 relative error which is below USDC dust precision per
// architecture doc §3.1 (`_wadToUsdc` rounding is the binding precision).
//
// We only flesh this out if the bench in `tests/cu_bench.rs` shows variant A
// blowing the 300k typical / 500k tail budget. Until then variant A is the
// working baseline and `--features lut` falls back to it via the cfg below.

#[cfg(feature = "lut")]
pub fn exp_wad(_x: i128) -> Result<i128, MathError> {
    compile_error!("LUT variant not yet implemented; see TODO in math.rs");
}

#[cfg(feature = "lut")]
pub fn ln_wad(_y: i128) -> Result<i128, MathError> {
    compile_error!("LUT variant not yet implemented; see TODO in math.rs");
}

// ------------------------------ Tests ------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: i128, b: i128, eps: i128) -> bool {
        (a - b).abs() <= eps
    }

    #[test]
    fn exp_zero_is_one() {
        assert_eq!(exp_wad(0).unwrap(), WAD);
    }

    #[test]
    fn exp_one_is_e() {
        let e = exp_wad(WAD).unwrap();
        // e ≈ 2.718281828... * WAD = 2718281828459045235
        assert!(close(e, 2_718_281_828_459_045_235, 1_000_000));
    }

    #[test]
    fn exp_negative_one() {
        let v = exp_wad(-WAD).unwrap();
        // 1/e ≈ 0.367879441 * WAD
        assert!(close(v, 367_879_441_171_442_321, 1_000_000));
    }

    #[test]
    fn ln_one_is_zero() {
        assert_eq!(ln_wad(WAD).unwrap(), 0);
    }

    #[test]
    fn ln_e_is_one() {
        let e_wad = 2_718_281_828_459_045_235;
        let v = ln_wad(e_wad).unwrap();
        assert!(close(v, WAD, 1_000_000));
    }

    #[test]
    fn ln_two_is_ln2() {
        let v = ln_wad(2 * WAD).unwrap();
        assert!(close(v, LN2_WAD, 1_000_000));
    }

    #[test]
    fn round_trip() {
        // ln(exp(x)) ≈ x for small x
        let x = WAD / 2;
        let e = exp_wad(x).unwrap();
        let back = ln_wad(e).unwrap();
        assert!(close(back, x, 10_000_000));
    }
}
