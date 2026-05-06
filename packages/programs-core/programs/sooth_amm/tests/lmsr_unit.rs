//! Host-side unit tests for the ported LMSR math.
//!
//! These run under regular `cargo test -p sooth_amm` (no SBF, no
//! BanksClient) — they exercise the `math` module directly and don't need
//! the Anchor framework. The CU benchmark stays in `_spikes/lmsr-cu/` and
//! is not duplicated here.

use sooth_amm::math::{cost_delta, exp_wad, ln_wad, wad_to_usdc_ceil, LN2_WAD, WAD};

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
    assert!(close(e, 2_718_281_828_459_045_235, 1_000_000));
}

#[test]
fn ln_e_is_one() {
    let e_wad = 2_718_281_828_459_045_235;
    let v = ln_wad(e_wad).unwrap();
    assert!(close(v, WAD, 1_000_000));
}

#[test]
fn ln_two_is_ln2() {
    assert!(close(ln_wad(2 * WAD).unwrap(), LN2_WAD, 1_000_000));
}

#[test]
fn ln_exp_round_trip() {
    for &x in &[WAD / 8, WAD / 4, WAD / 2, WAD, 2 * WAD, 5 * WAD, 10 * WAD] {
        let e = exp_wad(x).unwrap();
        let back = ln_wad(e).unwrap();
        assert!(
            close(back, x, 10_000_000),
            "ln(exp({x})) = {back}, expected {x}"
        );
    }
}

#[test]
fn cost_delta_buy_yes_costs_less_than_delta() {
    // From a balanced book (q_yes = q_no = 500·WAD, b = 1000·WAD), buying
    // 1% of b YES costs less than δ since the marginal price is < 1.
    let b = 1_000 * WAD;
    let q = 500 * WAD;
    let delta = b / 100;
    let dc = cost_delta(q, q, b, delta, 0).unwrap();
    assert!(dc > 0);
    assert!(dc < delta, "cost {dc} should be < delta {delta}");
}

#[test]
fn cost_delta_sell_returns_negative_cost() {
    // Selling reduces q; cost goes down, so `C(after) - C(before) < 0`
    // (negative = proceeds to user).
    let b = 1_000 * WAD;
    let q = 500 * WAD;
    let delta = b / 100;
    let dc_buy = cost_delta(q, q, b, delta, 0).unwrap();
    // Now sell from q_yes = 510·WAD back down by `delta` shares
    let dc_sell = cost_delta(q + delta, q, b, -delta, 0).unwrap();
    assert!(dc_sell < 0);
    // Round-trip should net ~0 (LMSR is path-independent within a single
    // trader; tiny truncation residue is fine).
    assert!(close(dc_buy + dc_sell, 0, 100_000_000));
}

/// Golden value pin: small-buy from empty balanced book, captured by
/// inspecting the spike's `lmsr_cost` output. This is the "small (delta = 1%
/// of b)" case from the bench grid — q=0/0, b=1000·WAD, d_yes = 10·WAD.
#[test]
fn cost_delta_golden_small_buy_range() {
    let b = 1_000 * WAD;
    let dc = cost_delta(0, 0, b, b / 100, 0).unwrap();
    // From empty balanced book, marginal price = 0.5; 10 shares at avg
    // price ≈ 5.0125 USDC. The exact LMSR closed form for symmetric q=0:
    //   C(d, 0, b) - C(0, 0, b) = b·(ln(1 + exp(-d/b)) - ln(2)) + d
    // For d/b = 0.01 this is 5_012_499_947_917_016_000 WAD on this
    // toolchain. Bound loosely so Taylor truncation drift across compiler
    // versions doesn't break the test, but anything off by a factor of 10
    // is caught.
    assert!(
        dc > 5_010_000_000_000_000_000 && dc < 5_015_000_000_000_000_000,
        "cost_delta out of expected range: {dc} WAD"
    );
    // ensure WAD constant is still the expected scalar
    assert_eq!(WAD, 1_000_000_000_000_000_000);
}

#[test]
fn wad_to_usdc_ceil_rounds_up() {
    // 1 WAD (1e-12 USDC) ceils to 1 base unit
    assert_eq!(wad_to_usdc_ceil(1).unwrap(), 1);
    // exact 1 USDC
    assert_eq!(wad_to_usdc_ceil(1_000_000_000_000).unwrap(), 1);
    // 1 USDC + 1 WAD ceils to 2 base units
    assert_eq!(wad_to_usdc_ceil(1_000_000_000_001).unwrap(), 2);
}
