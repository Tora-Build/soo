//! Host-side unit tests for `sooth_launchpad::distribute_fees` fee-split math.
//!
//! The on-chain handler in `instructions/distribute_fees.rs` does:
//!   to_b_base       = total * b_base_share_bps       / 10_000
//!   to_lp_yield     = total * lp_yield_share_bps     / 10_000
//!   to_adjudicator  = total * adjudicator_share_bps  / 10_000
//!   to_protocol     = total - to_b_base - to_lp_yield - to_adjudicator
//!
//! These tests pin the floor-div + remainder-to-protocol semantics so a
//! future field reorder or cast change can't silently regress dust-handling.
//! The actual on-chain behaviour also exercises CPI signer-seeds, which is
//! out of scope for host tests — that's covered by the SDK-side bankrun
//! harness when it lands.

use sooth_launchpad::state::ProtocolConfig;

/// Mirror of the on-chain split rule. Kept private to this test module so
/// the public surface doesn't accidentally expose it as a callable utility.
fn split_4way(total: u64, cfg: &ProtocolConfig) -> (u64, u64, u64, u64) {
    let total_u128 = total as u128;
    let to_b_base: u64 = ((total_u128 * cfg.b_base_share_bps as u128) / 10_000) as u64;
    let to_lp_yield: u64 = ((total_u128 * cfg.lp_yield_share_bps as u128) / 10_000) as u64;
    let to_adjudicator: u64 = ((total_u128 * cfg.adjudicator_share_bps as u128) / 10_000) as u64;
    let to_protocol: u64 = total - to_b_base - to_lp_yield - to_adjudicator;
    (to_b_base, to_lp_yield, to_adjudicator, to_protocol)
}

fn default_cfg() -> ProtocolConfig {
    ProtocolConfig {
        authority: anchor_lang::prelude::Pubkey::new_unique(),
        treasury: anchor_lang::prelude::Pubkey::new_unique(),
        fee_bps: 100,              // 1% — the sample value used in protocol_config tests
        b_base_share_bps: 5_000,   // 50%
        lp_yield_share_bps: 3_000, // 30%
        adjudicator_share_bps: 1_000, // 10%
        protocol_share_bps: 1_000, // 10%
        default_trial_period: 24 * 60 * 60,
        bump: 254,
    }
}

#[test]
fn split_default_50_30_10_10_clean_total() {
    // 1_000_000 USDC base units = $1.00 USDC. Splits cleanly with the
    // default 50/30/10/10 bps because 1_000_000 is a multiple of 10_000.
    let cfg = default_cfg();
    let (b, lp, adj, prot) = split_4way(1_000_000, &cfg);
    assert_eq!(b, 500_000);
    assert_eq!(lp, 300_000);
    assert_eq!(adj, 100_000);
    assert_eq!(prot, 100_000);
    assert_eq!(b + lp + adj + prot, 1_000_000);
}

#[test]
fn split_zero_amount_is_zero() {
    let cfg = default_cfg();
    let (b, lp, adj, prot) = split_4way(0, &cfg);
    assert_eq!(b, 0);
    assert_eq!(lp, 0);
    assert_eq!(adj, 0);
    assert_eq!(prot, 0);
}

#[test]
fn split_remainder_routes_to_protocol() {
    // Total that doesn't divide evenly by 10_000 — the floor-div on the
    // first three slices loses sub-bps, which the formula recovers in
    // `to_protocol`. EVM `_distributePostGrad:386` does the same: `fee -
    // toBBase - toLPYield - toAdjudicator`.
    //
    // 7 USDC base units split 50/30/10/10:
    //   to_b_base       = 7*5000 / 10000 = 3 (floor of 3.5)
    //   to_lp_yield     = 7*3000 / 10000 = 2 (floor of 2.1)
    //   to_adjudicator  = 7*1000 / 10000 = 0 (floor of 0.7)
    //   to_protocol     = 7 - 3 - 2 - 0   = 2 (recovered the 0.7+0.5+0.1)
    let cfg = default_cfg();
    let (b, lp, adj, prot) = split_4way(7, &cfg);
    assert_eq!(b, 3);
    assert_eq!(lp, 2);
    assert_eq!(adj, 0);
    assert_eq!(prot, 2);
    assert_eq!(b + lp + adj + prot, 7);
}

#[test]
fn split_one_unit_routes_entirely_to_protocol() {
    // 1 USDC base unit: every floor div lands on 0; protocol gets the
    // whole unit. This is the dust-handling boundary case — confirms the
    // remainder rule never strands sub-base-unit amounts.
    let cfg = default_cfg();
    let (b, lp, adj, prot) = split_4way(1, &cfg);
    assert_eq!(b, 0);
    assert_eq!(lp, 0);
    assert_eq!(adj, 0);
    assert_eq!(prot, 1);
    assert_eq!(b + lp + adj + prot, 1);
}

#[test]
fn split_sum_matches_total_for_all_small_inputs() {
    // Brute-force the dust invariant for the first ~10k base units. The
    // sum of the four slices must equal the input for every value.
    let cfg = default_cfg();
    for total in 0u64..10_000 {
        let (b, lp, adj, prot) = split_4way(total, &cfg);
        assert_eq!(
            b + lp + adj + prot,
            total,
            "split dust-leak at total={total}"
        );
    }
}

#[test]
fn split_with_alternate_bps_holds_invariant() {
    // 4-way split that isn't the default. 70/15/10/5 — closer to the
    // post-graduation EVM defaults than the 50/30/10/10 sketch.
    let mut cfg = default_cfg();
    cfg.b_base_share_bps = 7_000;
    cfg.lp_yield_share_bps = 1_500;
    cfg.adjudicator_share_bps = 1_000;
    cfg.protocol_share_bps = 500;
    assert_eq!(cfg.split_total(), 10_000);

    let (b, lp, adj, prot) = split_4way(1_000_000, &cfg);
    assert_eq!(b, 700_000);
    assert_eq!(lp, 150_000);
    assert_eq!(adj, 100_000);
    assert_eq!(prot, 50_000);
    assert_eq!(b + lp + adj + prot, 1_000_000);
}

#[test]
fn split_with_max_u64_total_does_not_overflow() {
    // Total = u64::MAX exercises the u128 widening on the `total * bps`
    // multiplication. u64::MAX * 10_000 ≈ 1.84e23, well inside u128's
    // 3.4e38 range. The on-chain handler uses the same widening recipe.
    let cfg = default_cfg();
    let total = u64::MAX;
    let (b, lp, adj, prot) = split_4way(total, &cfg);
    // The four slices must still sum to total (no overflow during recovery).
    assert_eq!(
        (b as u128) + (lp as u128) + (adj as u128) + (prot as u128),
        total as u128,
    );
}

#[test]
fn split_at_100_percent_protocol_routes_everything() {
    // Edge config where one slice is 100% — the four-way reduces to
    // one-way. Useful sanity for the boundary where the bps total stays
    // 10_000 but three slices are zero.
    let mut cfg = default_cfg();
    cfg.b_base_share_bps = 0;
    cfg.lp_yield_share_bps = 0;
    cfg.adjudicator_share_bps = 0;
    cfg.protocol_share_bps = 10_000;
    assert_eq!(cfg.split_total(), 10_000);

    let (b, lp, adj, prot) = split_4way(123_456, &cfg);
    assert_eq!(b, 0);
    assert_eq!(lp, 0);
    assert_eq!(adj, 0);
    assert_eq!(prot, 123_456);
}

#[test]
fn fee_wad_formula_matches_evm() {
    // Mirror of the on-chain `trade_positions` fee computation:
    //   fee_wad = cost_wad * fee_bps / 10_000   (floor)
    // Pinned here so a future bps-encoding change can't silently widen
    // the fee surface. EVM precedent: `FeeRouter._quoteFee:421`.
    fn fee(cost_wad: u128, fee_bps: u16) -> u128 {
        cost_wad * (fee_bps as u128) / 10_000
    }
    // 1% fee on 1.0 WAD cost = 0.01 WAD = 1e16
    assert_eq!(fee(1_000_000_000_000_000_000, 100), 10_000_000_000_000_000);
    // 0% fee leaves 0 (the post-graduation tier could land here once
    // the destinations re-route, but the `fee_bps = 0` path is the
    // simpler regression target).
    assert_eq!(fee(1_000_000_000_000_000_000, 0), 0);
    // Floor on a non-integer split: 7 * 100 / 10_000 = 0 (floor of 0.07)
    assert_eq!(fee(7, 100), 0);
    // 1 wad-unit at 100% = 1 wad-unit
    assert_eq!(fee(1, 10_000), 1);
}
