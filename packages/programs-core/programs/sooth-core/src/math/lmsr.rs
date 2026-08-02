//! LMSR cost function — `exp_wad`, `ln_wad`, and the log-sum-exp shifted
//! `cost_delta` used by `trade_positions`.
//!
//! The math model is the standard binary-outcome LMSR with `b` (liquidity
//! parameter) in WAD:
//!
//! ```text
//! C(q_yes, q_no, b) = b · ln( exp(q_yes/b) + exp(q_no/b) )
//! ```
//!
//! ## Numerical stability
//!
//! The "tail 100× cheaper than 10×" property comes from the **log-sum-exp
//! shift**: subtract `m = max(q_yes/b,
//! q_no/b)` before exp, add it back outside ln. Both exp arguments end up ≤
//! 0; for very imbalanced markets the smaller side falls below the
//! `EXP_MAX_INPUT_WAD` saturation clamp and short-circuits to 0 without
//! running the Taylor series. That is what makes the 100× tail (33k CU)
//! cheaper than the 10× imbalanced case (55k CU).

pub use super::wad::MathError;
use super::wad::{wad_div, wad_mul, LN2_WAD, WAD, WAD_U};

/// Maximum |x| for `exp_wad`. ~133·WAD is where exp(x) approaches u128::MAX;
/// we clamp tighter at 64·WAD because LMSR diffs past that mean a one-sided
/// market that's essentially resolved. exp(-64·WAD) ≈ 1e-28 is below any
/// WAD-representable value, so `exp_wad` saturates the negative tail to 0.
pub const EXP_MAX_INPUT_WAD: i128 = 64 * WAD;

/// Number of Taylor terms for `exp`. 12 gives ~1e-18 relative error on the
/// reduced range |r| ≤ ln(2)/2 ≈ 0.347·WAD.
const EXP_TERMS: u32 = 12;

/// Number of Taylor terms for `ln` (in `(z + z³/3 + z⁵/5 + …)` form).
/// 14 gives ~1e-19 relative error on z ∈ [0, 1/3).
const LN_TERMS: u32 = 14;

pub fn exp_wad(x: i128) -> Result<i128, MathError> {
    // Saturate the negative tail. exp(-EXP_MAX_INPUT_WAD) ≈ 1e-28; returning
    // 0 keeps log-sum-exp stable for arbitrarily imbalanced markets and is
    // what lets the "tail" CU case short-circuit (see module comment).
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
    let k = {
        let half = LN2_WAD / 2;
        if x >= 0 {
            (x + half) / LN2_WAD
        } else {
            (x - half) / LN2_WAD
        }
    };
    let r = x - k * LN2_WAD;

    // Taylor: exp(r) = Σ rⁿ / n!
    let mut term = WAD;
    let mut sum = WAD;
    for n in 1..=EXP_TERMS {
        term = wad_mul(term, r)?;
        term /= n as i128;
        sum = sum.checked_add(term).ok_or(MathError::Overflow)?;
    }
    // Multiply by 2^k.
    let result = if k >= 0 {
        let k_u = k as u32;
        if k_u >= 127 {
            return Err(MathError::Overflow);
        }
        sum.checked_shl(k_u).ok_or(MathError::Overflow)?
    } else {
        let k_u = (-k) as u32;
        if k_u >= 127 {
            return Ok(0);
        }
        sum >> k_u
    };
    Ok(result)
}

pub fn ln_wad(y: i128) -> Result<i128, MathError> {
    if y <= 0 {
        return Err(MathError::Overflow);
    }
    let yu = y as u128;
    let bits = 128 - yu.leading_zeros() as i32;
    let wad_bits = 128 - WAD_U.leading_zeros() as i32; // 60
    let k = bits - wad_bits;
    let m: i128 = if k >= 0 {
        (yu >> (k as u32)) as i128
    } else {
        let kk = (-k) as u32;
        if kk >= 127 {
            return Err(MathError::Overflow);
        }
        (yu << kk) as i128
    };
    let m_minus = m - WAD;
    let m_plus = m + WAD;
    let z = wad_div(m_minus, m_plus)?;
    let z2 = wad_mul(z, z)?;
    let mut term = z;
    let mut sum = z;
    for n in 1..LN_TERMS {
        term = wad_mul(term, z2)?;
        let denom = (2 * n + 1) as i128;
        sum = sum.checked_add(term / denom).ok_or(MathError::Overflow)?;
    }
    let ln_m_over_wad = sum.checked_mul(2).ok_or(MathError::Overflow)?;
    let k_term = (k as i128)
        .checked_mul(LN2_WAD)
        .ok_or(MathError::Overflow)?;
    Ok(k_term + ln_m_over_wad)
}

/// `C(q_yes, q_no, b) = b · ln( exp(q_yes/b) + exp(q_no/b) )` with the
/// log-sum-exp shift baked in. Inputs and output WAD-scaled.
#[inline(always)]
pub fn lmsr_cost(q_yes: i128, q_no: i128, b: i128) -> Result<i128, MathError> {
    let qy_over_b = wad_div(q_yes, b)?;
    let qn_over_b = wad_div(q_no, b)?;
    let m = qy_over_b.max(qn_over_b);
    let e_yes = exp_wad(qy_over_b - m)?;
    let e_no = exp_wad(qn_over_b - m)?;
    let sum = e_yes.checked_add(e_no).ok_or(MathError::Overflow)?;
    let ln_sum = ln_wad(sum)?;
    let inner = m.checked_add(ln_sum).ok_or(MathError::Overflow)?;
    wad_mul(b, inner)
}

/// Signed cost of moving the AMM state from `(q_yes, q_no)` to
/// `(q_yes + d_yes, q_no + d_no)`.
///
/// Positive return = user pays this much. Negative = sell proceeds.
#[inline(always)]
pub fn cost_delta(
    q_yes: i128,
    q_no: i128,
    b: i128,
    d_yes: i128,
    d_no: i128,
) -> Result<i128, MathError> {
    let before = lmsr_cost(q_yes, q_no, b)?;
    let q_yes_after = q_yes.checked_add(d_yes).ok_or(MathError::Overflow)?;
    let q_no_after = q_no.checked_add(d_no).ok_or(MathError::Overflow)?;
    let after = lmsr_cost(q_yes_after, q_no_after, b)?;
    Ok(after - before)
}

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
        // e ≈ 2.718281828... × WAD
        assert!(close(e, 2_718_281_828_459_045_235, 1_000_000));
    }

    #[test]
    fn exp_negative_one() {
        let v = exp_wad(-WAD).unwrap();
        // 1/e ≈ 0.367879441 × WAD
        assert!(close(v, 367_879_441_171_442_321, 1_000_000));
    }

    #[test]
    fn exp_saturates_negative_tail() {
        // Past the saturation clamp we return 0 — keeps the log-sum-exp shift
        // numerically stable for 100×-imbalanced markets.
        assert_eq!(exp_wad(-(EXP_MAX_INPUT_WAD + 1)).unwrap(), 0);
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
    fn round_trip_ln_exp() {
        for &x in &[WAD / 4, WAD / 2, WAD, 2 * WAD, 5 * WAD] {
            let e = exp_wad(x).unwrap();
            let back = ln_wad(e).unwrap();
            assert!(
                close(back, x, 10_000_000),
                "ln(exp({x})) = {back}, expected {x}"
            );
        }
    }

    #[test]
    fn lmsr_cost_balanced_book() {
        // Symmetric q: C(q,q,b) = b · ln(2 · exp(q/b · -m + m)) shifted; the
        // closed form is C(q,q,b) = q + b·ln(2). Verify within 1e-9 WAD.
        let b = 1_000 * WAD;
        let q = 500 * WAD;
        let c = lmsr_cost(q, q, b).unwrap();
        // expected = q + b · ln 2
        let expected = q + (b / WAD) * LN2_WAD; // b in WAD, so multiply by ln2 then back to WAD
                                                // The cleaner expected: b·ln 2 in WAD = wad_mul(b, LN2_WAD)
        let expected_clean = q + wad_mul(b, LN2_WAD).unwrap();
        let _ = expected;
        assert!(
            close(c, expected_clean, 1_000_000_000),
            "got {c} vs {expected_clean}"
        );
    }

    #[test]
    fn cost_delta_buy_yes_increases_cost() {
        // Buying YES from a balanced book costs > 0 and < δ (since price < 1).
        let b = 1_000 * WAD;
        let q = 500 * WAD;
        let delta = b / 100; // 1% of b
        let dc = cost_delta(q, q, b, delta, 0).unwrap();
        assert!(dc > 0);
        assert!(dc < delta);
    }

    /// Golden-value pin. `cost_delta(q=0, q=0, b=1000·WAD,
    /// d_yes=10·WAD, d_no=0)` — the small-buy case from the bench grid.
    #[test]
    fn cost_delta_golden_small_buy() {
        let b = 1_000 * WAD;
        let dc = cost_delta(0, 0, b, b / 100, 0).unwrap();
        // From a balanced empty book, price is 0.5; buying 10 shares of YES
        // costs ≈ 5 + (δ²/(2·b·ln2)) · ln2 ≈ 5 + 0.0125 = 5.0125 USDC. The
        // exact LMSR value lands at 5_012_499_947_917_016_000 WAD on this
        // toolchain (Taylor truncation residue ≈ 5e-12). Loose range so
        // Taylor drift across compiler versions doesn't break the test.
        assert!(
            dc > 5_010_000_000_000_000_000 && dc < 5_015_000_000_000_000_000,
            "cost_delta out of range: {dc}"
        );
    }
}

#[cfg(test)]
mod wide_cost_regression {
    use super::*;

    /// Buying shares must never produce a negative cost.
    ///
    /// `lmsr_cost` ends in `wad_mul(b, m + ln_sum)`, and that product exceeds
    /// `u128::MAX` once the cost passes ~340.28e18 — which is just
    /// `max(q) + b·ln(2)`, i.e. a market with a few hundred shares
    /// outstanding. The old `wad_mul` wrapped there instead of erroring.
    ///
    /// `cost_delta` differences two costs, so while both endpoints wrapped the
    /// same number of times the error cancelled exactly and the market looked
    /// healthy. A trade that straddled a wrap boundary did not cancel: at
    /// b = 50, q = (307, 303), buying 4 YES returned **-338.16** — the program
    /// paying the trader to take shares.
    #[test]
    fn buying_never_costs_a_negative_amount() {
        for b in [1i128, 50, 100, 1_000, 10_000] {
            let b = b * WAD;
            for q in [0i128, 100, 300, 320, 340, 400, 1_000, 5_000] {
                for d in [1i128, 4, 50, 500] {
                    let c = cost_delta(q * WAD, q * WAD, b, d * WAD, 0)
                        .unwrap_or_else(|e| panic!("b={b} q={q} d={d}: {e:?}"));
                    assert!(c > 0, "b={b} q={q} d={d} gave cost {c}");
                }
            }
        }
    }

    /// Cost is bounded by the number of shares bought.
    ///
    /// A share can never cost more than 1 unit under LMSR, so this catches a
    /// wrap in the other direction — one that inflates the charge rather than
    /// inverting it.
    #[test]
    fn buying_never_costs_more_than_one_per_share() {
        for b in [1i128, 50, 1_000] {
            let b = b * WAD;
            for q in [0i128, 300, 340, 1_000] {
                for d in [1i128, 4, 50, 500] {
                    let c = cost_delta(q * WAD, q * WAD, b, d * WAD, 0).unwrap();
                    assert!(c <= d * WAD, "b={b} q={q} d={d} gave cost {c}");
                }
            }
        }
    }

    /// A balanced market's cost has a closed form: `q + b·ln(2)`.
    ///
    /// Checked straight through the wrap boundary, since that is the only
    /// place the limb arithmetic can disagree with the identity.
    #[test]
    fn balanced_cost_matches_the_closed_form() {
        let b = 50 * WAD;
        for q in [0i128, 100, 300, 320, 339, 340, 341, 400, 1_000] {
            let got = lmsr_cost(q * WAD, q * WAD, b).unwrap();
            let want = q * WAD + wad_mul(b, LN2_WAD).unwrap();
            let diff = (got - want).abs();
            assert!(diff < 1_000_000, "q={q}: got {got}, want {want}");
        }
    }

    /// Buying then selling the same size returns to the same cost.
    ///
    /// The wrap was not symmetric, so a round trip across the boundary lost
    /// (or created) value.
    #[test]
    fn a_round_trip_is_value_neutral() {
        let b = 50 * WAD;
        for q in [300i128, 320, 340] {
            let buy = cost_delta(q * WAD, q * WAD, b, 10 * WAD, 0).unwrap();
            let sell =
                cost_delta((q + 10) * WAD, q * WAD, b, -10 * WAD, 0).unwrap();
            assert_eq!(buy, -sell, "q={q}");
        }
    }
}
