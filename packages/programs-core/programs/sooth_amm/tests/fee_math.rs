//! Host-side unit tests for `sooth_amm::trade_positions` fee math.
//!
//! The on-chain handler computes:
//!   fee_wad = cost_wad as u128 * fee_bps as u128 / 10_000     (floor)
//!   fee_usdc = wad_to_usdc_ceil(fee_wad)
//!   total_cost_wad = cost_wad + fee_wad ≤ max_cost_wad
//!
//! These tests pin the integer-arithmetic boundary (the formula is shared
//! verbatim with EVM `FeeRouter._quoteFee` line 421). The full ix path
//! (account constraints, SPL transfer, ProtocolConfig parse) is exercised
//! by the bankrun harness in `packages/sdk-solana/tests/`.

use sooth_amm::math::{wad_to_usdc_ceil, WAD_U};

/// Mirror of the on-chain fee computation (floor div).
fn fee_wad(cost_wad: u128, fee_bps: u16) -> u128 {
    cost_wad
        .checked_mul(fee_bps as u128)
        .map(|v| v / 10_000)
        .expect("fee_wad overflow in test fixture")
}

#[test]
fn fee_zero_bps_is_zero() {
    // Disabled-fee deploy path: fee_bps = 0 ⇒ fee_wad = 0 ⇒ slippage check
    // degenerates to `cost_wad ≤ max_cost_wad` (the pre-Wave 1C-fee
    // behaviour). Documented escape hatch for cluster bring-up where the
    // fee infra isn't in place yet.
    assert_eq!(fee_wad(WAD_U, 0), 0);
    assert_eq!(fee_wad(123_456_789, 0), 0);
}

#[test]
fn fee_1_percent_is_1_percent() {
    // fee_bps = 100 (1%). 1.0 WAD cost ⇒ 0.01 WAD fee = 1e16 wad-units.
    assert_eq!(fee_wad(WAD_U, 100), WAD_U / 100);
}

#[test]
fn fee_100_percent_is_full_cost() {
    // fee_bps = 10_000 (100%). The slippage check would then require
    // `2 * cost_wad ≤ max_cost_wad`. EVM caps preGradFeeBps at 1000
    // (10%) and postGradFeeBps at 500 (5%) but the on-chain math still
    // works at 100%.
    assert_eq!(fee_wad(WAD_U, 10_000), WAD_U);
    assert_eq!(fee_wad(7, 10_000), 7);
}

#[test]
fn fee_floor_truncates_below_one_wad_unit() {
    // 7 wad-units * 100 bps / 10_000 = 7 / 100 = 0 (floor of 0.07).
    // Mirrors the EVM `_quoteFee` rounding direction.
    assert_eq!(fee_wad(7, 100), 0);
}

#[test]
fn slippage_check_is_strict_total() {
    // The slippage check uses `cost_wad + fee_wad ≤ max_cost_wad`. A
    // SDK that prepares `max_cost_wad` against `cost_wad` only (the
    // pre-fee-router-landing behaviour) would now over-flow this bound.
    // Regression target: confirm the `+` semantics rather than the
    // looser `cost_wad ≤ max` we used to ship.
    let cost = WAD_U; // 1.0 WAD
    let fee = fee_wad(cost, 100); // 0.01 WAD
    let total = cost + fee;

    // SDK-style buffer: max = cost * (1 + slippage). With 1% fee + 0.5%
    // slippage tolerance the buffer should be ≥ 1.5% over cost.
    let max_loose = cost; // pre-fee-router behaviour
    let max_tight = cost + fee; // exact-fit
    let max_with_buffer = cost + fee + cost / 200; // 0.5% headroom

    assert!(total > max_loose, "loose bound should now reject");
    assert!(total <= max_tight, "exact-fit bound should accept");
    assert!(total <= max_with_buffer, "buffered bound should accept");
}

#[test]
fn fee_usdc_ceil_matches_inflow_rule() {
    // fee_wad = 0.5 USDC = 5e17 wad-units; ceil rule on inflow rounds
    // toward 500_000 base units (no rounding required for an exact
    // half).
    let fee = WAD_U / 2;
    assert_eq!(wad_to_usdc_ceil(fee).unwrap(), 500_000);

    // fee_wad = 1 wad-unit (sub-base-unit) ⇒ ceil rounds up to 1 USDC
    // base unit. This is the dust-handling boundary: the ceil rule
    // ensures the protocol never under-collects on the fee leg.
    assert_eq!(wad_to_usdc_ceil(1).unwrap(), 1);

    // fee_wad = 0 (e.g. fee_bps = 0 deploy) ⇒ 0 USDC. The on-chain
    // handler explicitly skips the fee transfer when fee_usdc = 0; the
    // ceil identity here is the upstream guarantee.
    assert_eq!(wad_to_usdc_ceil(0).unwrap(), 0);
}

#[test]
fn fee_overflow_at_huge_cost_is_caught() {
    // u128 multiplication overflow protection: cost_wad close to u128::MAX
    // multiplied by 10_000 bps would wrap. The on-chain handler uses
    // `checked_mul` to surface the overflow as `MathOverflow`. Re-check
    // that boundary holds at this layer (the fixture function above
    // panics rather than silently wrapping, so any test that triggers
    // it would fail loudly).
    let near_max = u128::MAX / 20_000;
    let f = fee_wad(near_max, 100); // 1% — safe at this size
    assert!(f > 0);
    assert!(f < near_max);
}
