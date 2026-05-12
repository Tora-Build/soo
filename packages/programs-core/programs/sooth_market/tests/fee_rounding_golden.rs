use sooth_market::instructions::orderbook_common::{
    compute_taker_pull_from_fee_wad, BASE_UNIT_WAD,
};

#[derive(Clone, Copy)]
struct FeeFixture {
    base_cost_wad: u128,
    fee_wad: u128,
    expected_fee_base: u64,
}

const MAX_BASE_UNITS_SAFE_WAD: u128 = (u64::MAX as u128 - 1) * BASE_UNIT_WAD;

const FIXTURES: &[FeeFixture] = &[
    FeeFixture {
        base_cost_wad: BASE_UNIT_WAD - 1,
        fee_wad: 1,
        expected_fee_base: 1,
    },
    FeeFixture {
        base_cost_wad: BASE_UNIT_WAD - 1,
        fee_wad: 2,
        expected_fee_base: 1,
    },
    FeeFixture {
        base_cost_wad: BASE_UNIT_WAD,
        fee_wad: 1,
        expected_fee_base: 0,
    },
    FeeFixture {
        base_cost_wad: BASE_UNIT_WAD + 1,
        fee_wad: BASE_UNIT_WAD - 1,
        expected_fee_base: 1,
    },
    FeeFixture {
        base_cost_wad: 1_000_000 * BASE_UNIT_WAD,
        fee_wad: 1,
        expected_fee_base: 0,
    },
    FeeFixture {
        base_cost_wad: 1_000_000 * BASE_UNIT_WAD - 1,
        fee_wad: 1,
        expected_fee_base: 1,
    },
    FeeFixture {
        base_cost_wad: 1_234_567_890_123,
        fee_wad: 987_654_321_098,
        expected_fee_base: 1,
    },
    FeeFixture {
        base_cost_wad: 42 * BASE_UNIT_WAD + BASE_UNIT_WAD - 1,
        fee_wad: 2,
        expected_fee_base: 1,
    },
    FeeFixture {
        base_cost_wad: 5 * BASE_UNIT_WAD + 500_000_000_000,
        fee_wad: 499_999_999_999,
        expected_fee_base: 0,
    },
    FeeFixture {
        base_cost_wad: 5 * BASE_UNIT_WAD + 500_000_000_000,
        fee_wad: 500_000_000_000,
        expected_fee_base: 1,
    },
    FeeFixture {
        base_cost_wad: MAX_BASE_UNITS_SAFE_WAD + BASE_UNIT_WAD - 1,
        fee_wad: 1,
        expected_fee_base: 1,
    },
];

#[test]
fn fee_rounding_golden() {
    for fixture in FIXTURES {
        let (_, actual_fee_base, _) =
            compute_taker_pull_from_fee_wad(fixture.base_cost_wad, fixture.fee_wad)
                .expect("golden fixture must fit in u64 base units");
        let evm_expected = evm_fee_base_units(fixture.base_cost_wad, fixture.fee_wad);
        assert_eq!(fixture.expected_fee_base, evm_expected);
        assert_eq!(
            actual_fee_base, fixture.expected_fee_base,
            "baseCostWad={} feeWad={}",
            fixture.base_cost_wad, fixture.fee_wad
        );
    }
}

#[test]
fn fee_rounding_golden_includes_floor_on_sum_dust_cases() {
    let differs_from_separate_floor = FIXTURES.iter().filter(|fixture| {
        let separate_floor_fee = fixture.fee_wad / BASE_UNIT_WAD;
        fixture.expected_fee_base as u128 != separate_floor_fee
    });
    assert!(differs_from_separate_floor.count() >= 6);
}

#[test]
fn fee_rounding_golden_rejects_sub_base_unit_total_pull() {
    for (base_cost_wad, fee_wad) in [(1, 1), (BASE_UNIT_WAD - 2, 1)] {
        assert!(compute_taker_pull_from_fee_wad(base_cost_wad, fee_wad).is_err());
    }
}

fn evm_fee_base_units(base_cost_wad: u128, fee_wad: u128) -> u64 {
    let taker_base_cost = base_cost_wad / BASE_UNIT_WAD;
    let taker_cost_plus_fee = (base_cost_wad + fee_wad) / BASE_UNIT_WAD;
    (taker_cost_plus_fee - taker_base_cost)
        .try_into()
        .expect("fixture expected fee must fit u64")
}
