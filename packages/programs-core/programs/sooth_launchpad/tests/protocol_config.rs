//! Host-side unit tests for `ProtocolConfig` layout + invariants.
//!
//! These run under regular `cargo test -p sooth_launchpad` (no SBF, no
//! BanksClient) — they validate the in-memory shape of the singleton config
//! account and the `split_total()` invariant. Integration tests with a live
//! validator stay in `tests/anchor/` (TS) once the workspace has them wired.

use anchor_lang::prelude::Pubkey;
use sooth_launchpad::state::ProtocolConfig;

fn fresh_config() -> ProtocolConfig {
    ProtocolConfig {
        authority: Pubkey::new_unique(),
        treasury: Pubkey::new_unique(),
        fee_bps: 100, // 1%
        b_base_share_bps: 5_000,
        lp_yield_share_bps: 3_000,
        adjudicator_share_bps: 1_000,
        protocol_share_bps: 1_000,
        default_trial_period: 24 * 60 * 60,
        bump: 254,
    }
}

#[test]
fn split_bps_sum_to_10000_default() {
    // Architecture §8 default: 50/30/10/10. The sum-to-10_000 invariant is
    // load-bearing — `distribute_fees` divides by 10_000 and a mismatched
    // split would silently lose dust on every distribution.
    let cfg = fresh_config();
    assert_eq!(cfg.split_total(), 10_000);
}

#[test]
fn split_bps_detects_mismatch() {
    let mut cfg = fresh_config();
    cfg.protocol_share_bps = 999; // 9_999 total
    assert_ne!(cfg.split_total(), 10_000);
}

#[test]
fn space_constant_matches_layout() {
    // Anchor's `init` constraint allocates exactly `ProtocolConfig::SPACE`
    // bytes including the 8-byte discriminator. Re-derive the layout total
    // here so a future field add that forgets to update `SPACE` trips this
    // test rather than silently truncating account writes at runtime.
    let expected = 8         // discriminator
        + 32                 // authority
        + 32                 // treasury
        + 2                  // fee_bps
        + 2 * 4              // 4 share bps
        + 8                  // default_trial_period
        + 1; // bump
    assert_eq!(ProtocolConfig::SPACE, expected);
}

#[test]
fn fee_bps_max_constant_is_10000() {
    use sooth_launchpad::state::protocol_config::MAX_FEE_BPS;
    assert_eq!(MAX_FEE_BPS, 10_000);
}
