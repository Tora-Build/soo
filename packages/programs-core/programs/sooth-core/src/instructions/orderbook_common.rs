//! Orderbook helpers shared by the CLOB instructions.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::math::{NUM_TICKS, BASE_UNIT_WAD};
use crate::state::{Market, OrderbookPosition, ProtocolConfig};

pub const BPS_DENOMINATOR: u128 = 10_000;

pub fn base_to_wad(base_units: u64) -> Result<u128> {
    (base_units as u128)
        .checked_mul(BASE_UNIT_WAD)
        .ok_or(error!(SoothCoreError::MathOverflow))
}

pub fn wad_to_base(wad: u128) -> Result<u64> {
    (wad / BASE_UNIT_WAD)
        .try_into()
        .map_err(|_| error!(SoothCoreError::MathOverflow))
}

pub fn tick_cost_wad(tick: u16, shares: u128) -> Result<u128> {
    require!(tick <= NUM_TICKS, SoothCoreError::InvalidTick);
    shares
        .checked_mul(tick as u128)
        .ok_or(error!(SoothCoreError::MathOverflow))?
        .checked_div(NUM_TICKS as u128)
        .ok_or(error!(SoothCoreError::MathOverflow))
}

pub fn complement_tick_cost_wad(tick: u16, shares: u128) -> Result<u128> {
    require!(tick <= NUM_TICKS, SoothCoreError::InvalidTick);
    shares
        .checked_mul((NUM_TICKS - tick) as u128)
        .ok_or(error!(SoothCoreError::MathOverflow))?
        .checked_div(NUM_TICKS as u128)
        .ok_or(error!(SoothCoreError::MathOverflow))
}

/// Read fee_bps from the typed ProtocolConfig account.
pub fn read_fee_bps(protocol_config: &Account<ProtocolConfig>) -> u16 {
    protocol_config.fee_bps
}

/// Create and zero-initialize an `OrderbookPosition` PDA that does not exist yet.
///
/// The CLOB paths hold maker/taker positions as raw `AccountInfo` (they arrive via
/// `remaining_accounts`), so Anchor's `init_if_needed` is unavailable and the account
/// must be created by hand. Funding the address is *not* enough: a system account with
/// zero data length cannot be written to, so `allocate` + `assign` (or `create_account`,
/// which does both) is mandatory before serializing.
///
/// Callers must have already verified `info.data_is_empty()`.
pub fn create_orderbook_position<'info>(
    info: &AccountInfo<'info>,
    market: &Account<'info, Market>,
    user: Pubkey,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
    rent: &Rent,
) -> Result<OrderbookPosition> {
    use anchor_lang::system_program;

    let space = OrderbookPosition::SPACE;
    let lamports = rent.minimum_balance(space);

    let (expected, bump) = Pubkey::find_program_address(
        &[
            b"orderbook_position",
            market.market_id.as_ref(),
            user.as_ref(),
        ],
        &crate::ID,
    );
    require_keys_eq!(*info.key, expected, SoothCoreError::MakerAccountMismatch);

    let bump_seed = [bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"orderbook_position",
        market.market_id.as_ref(),
        user.as_ref(),
        bump_seed.as_ref(),
    ]];

    let current = info.lamports();
    if current == 0 {
        system_program::create_account(
            CpiContext::new_with_signer(
                system_program.to_account_info(),
                system_program::CreateAccount {
                    from: payer.to_account_info(),
                    to: info.clone(),
                },
                signer_seeds,
            ),
            lamports,
            space as u64,
            &crate::ID,
        )?;
    } else {
        // The PDA was pre-funded (anyone can send lamports to any address), which
        // makes `create_account` fail. Top up to rent-exemption, then allocate and
        // assign explicitly — the same fallback Anchor's `init` uses.
        if current < lamports {
            system_program::transfer(
                CpiContext::new(
                    system_program.to_account_info(),
                    system_program::Transfer {
                        from: payer.to_account_info(),
                        to: info.clone(),
                    },
                ),
                lamports - current,
            )?;
        }
        system_program::allocate(
            CpiContext::new_with_signer(
                system_program.to_account_info(),
                system_program::Allocate {
                    account_to_allocate: info.clone(),
                },
                signer_seeds,
            ),
            space as u64,
        )?;
        system_program::assign(
            CpiContext::new_with_signer(
                system_program.to_account_info(),
                system_program::Assign {
                    account_to_assign: info.clone(),
                },
                signer_seeds,
            ),
            &crate::ID,
        )?;
    }

    let position = OrderbookPosition {
        market: market.key(),
        user,
        yes_shares: 0,
        no_shares: 0,
        _reserved: [0u8; 16],
    };
    let mut data = info.try_borrow_mut_data()?;
    let mut cursor: &mut [u8] = &mut data;
    position.try_serialize(&mut cursor)?;

    Ok(position)
}

pub fn compute_taker_pull_from_fee_wad(
    base_cost_wad: u128,
    fee_wad: u128,
) -> Result<(u64, u64, u64)> {
    let taker_base_cost = wad_to_base(base_cost_wad)?;
    let cost_plus_fee_wad = base_cost_wad
        .checked_add(fee_wad)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    let taker_cost_plus_fee = wad_to_base(cost_plus_fee_wad)?;
    require!(
        taker_cost_plus_fee > 0,
        SoothCoreError::AmountTooSmallForBaseTokenDecimals
    );
    let fee_base = taker_cost_plus_fee
        .checked_sub(taker_base_cost)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    Ok((taker_base_cost, fee_base, taker_cost_plus_fee))
}

pub fn compute_taker_pull(base_cost_wad: u128, fee_bps: u16) -> Result<(u64, u64, u64)> {
    let fee_wad = base_cost_wad
        .checked_mul(fee_bps as u128)
        .ok_or(error!(SoothCoreError::MathOverflow))?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    compute_taker_pull_from_fee_wad(base_cost_wad, fee_wad)
}

pub fn require_before_deadline(market: &Market) -> Result<()> {
    require_before_deadline_at(market, Clock::get()?.unix_timestamp)
}

pub fn require_before_deadline_at(market: &Market, now: i64) -> Result<()> {
    require!(market.is_open(), SoothCoreError::MarketNotOpen);
    require!(now < market.deadline, SoothCoreError::TradingClosed);
    Ok(())
}

pub fn ensure_position_identity(
    position: &mut OrderbookPosition,
    market: Pubkey,
    user: Pubkey,
) -> Result<()> {
    if position.market == Pubkey::default() {
        position.market = market;
        position.user = user;
        return Ok(());
    }
    require_keys_eq!(
        position.market,
        market,
        SoothCoreError::VaultAuthorityMismatch
    );
    require_keys_eq!(
        position.user,
        user,
        SoothCoreError::VaultAuthorityMismatch
    );
    Ok(())
}

pub fn credit_shares(position: &mut OrderbookPosition, outcome: u8, amount: u128) -> Result<()> {
    match outcome {
        1 => {
            position.yes_shares = position
                .yes_shares
                .checked_add(amount)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
        }
        0 => {
            position.no_shares = position
                .no_shares
                .checked_add(amount)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
        }
        _ => return Err(error!(SoothCoreError::InvalidOutcome)),
    }
    Ok(())
}

pub fn debit_shares(position: &mut OrderbookPosition, outcome: u8, amount: u128) -> Result<()> {
    match outcome {
        1 => {
            require!(
                position.yes_shares >= amount,
                SoothCoreError::InsufficientOutcomeShares
            );
            position.yes_shares = position
                .yes_shares
                .checked_sub(amount)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
        }
        0 => {
            require!(
                position.no_shares >= amount,
                SoothCoreError::InsufficientOutcomeShares
            );
            position.no_shares = position
                .no_shares
                .checked_sub(amount)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
        }
        _ => return Err(error!(SoothCoreError::InvalidOutcome)),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Fee-rounding golden fixtures ──────────────────────────────────────
    //
    // Ported from main's sooth_market/tests/fee_rounding_golden.rs, which the
    // 5→1 merge deleted along with the rest of the Rust test tree. The
    // functions moved into this module, so the tests move in-src with them —
    // they are pure integer arithmetic and need no validator.
    //
    // These pin the "floor-on-sum" rule: the fee is
    //
    //     floor((base_cost + fee) / BASE_UNIT) - floor(base_cost / BASE_UNIT)
    //
    // NOT floor(fee / BASE_UNIT). The two disagree whenever base_cost has a
    // sub-base-unit remainder, and EVM `OrderEngine` uses the former. Getting
    // this wrong is a silent fee drift against the EVM implementation, which
    // docs/spec/sooth_book.md rates Med likelihood / HIGH impact.

    struct FeeFixture {
        base_cost_wad: u128,
        fee_wad: u128,
        expected_fee_base: u64,
    }

    const MAX_BASE_UNITS_SAFE_WAD: u128 = (u64::MAX as u128 - 1) * BASE_UNIT_WAD;

    const FIXTURES: &[FeeFixture] = &[
        // Sub-base-unit cost, tiny fee: the sum crosses a base-unit boundary.
        FeeFixture { base_cost_wad: BASE_UNIT_WAD - 1, fee_wad: 1, expected_fee_base: 1 },
        FeeFixture { base_cost_wad: BASE_UNIT_WAD - 1, fee_wad: 2, expected_fee_base: 1 },
        // Exact base unit: a 1-wad fee rounds away entirely.
        FeeFixture { base_cost_wad: BASE_UNIT_WAD, fee_wad: 1, expected_fee_base: 0 },
        FeeFixture { base_cost_wad: BASE_UNIT_WAD + 1, fee_wad: BASE_UNIT_WAD - 1, expected_fee_base: 1 },
        // Large cost, dust fee — still floors to nothing.
        FeeFixture { base_cost_wad: 1_000_000 * BASE_UNIT_WAD, fee_wad: 1, expected_fee_base: 0 },
        FeeFixture { base_cost_wad: 1_000_000 * BASE_UNIT_WAD - 1, fee_wad: 1, expected_fee_base: 1 },
        // Both operands sub-base-unit.
        FeeFixture { base_cost_wad: 1_234_567_890_123, fee_wad: 987_654_321_098, expected_fee_base: 1 },
        FeeFixture { base_cost_wad: 42 * BASE_UNIT_WAD + BASE_UNIT_WAD - 1, fee_wad: 2, expected_fee_base: 1 },
        // Exactly-at-the-boundary pair: one wad decides 0 vs 1.
        FeeFixture { base_cost_wad: 5 * BASE_UNIT_WAD + 500_000_000_000, fee_wad: 499_999_999_999, expected_fee_base: 0 },
        FeeFixture { base_cost_wad: 5 * BASE_UNIT_WAD + 500_000_000_000, fee_wad: 500_000_000_000, expected_fee_base: 1 },
        // Near the u64 base-unit ceiling.
        FeeFixture { base_cost_wad: MAX_BASE_UNITS_SAFE_WAD + BASE_UNIT_WAD - 1, fee_wad: 1, expected_fee_base: 1 },
    ];

    /// Independent reimplementation of EVM's fee derivation. Deliberately not
    /// calling the code under test, so a bug in `compute_taker_pull_from_fee_wad`
    /// cannot make the fixtures agree with themselves.
    fn evm_fee_base_units(base_cost_wad: u128, fee_wad: u128) -> u64 {
        let taker_base_cost = base_cost_wad / BASE_UNIT_WAD;
        let taker_cost_plus_fee = (base_cost_wad + fee_wad) / BASE_UNIT_WAD;
        (taker_cost_plus_fee - taker_base_cost)
            .try_into()
            .expect("fixture expected fee must fit u64")
    }

    #[test]
    fn fee_rounding_golden() {
        for fixture in FIXTURES {
            let (_, actual_fee_base, _) =
                compute_taker_pull_from_fee_wad(fixture.base_cost_wad, fixture.fee_wad)
                    .expect("golden fixture must fit in u64 base units");
            // Fixture agrees with the EVM formula...
            assert_eq!(
                fixture.expected_fee_base,
                evm_fee_base_units(fixture.base_cost_wad, fixture.fee_wad),
                "fixture disagrees with EVM formula: baseCostWad={} feeWad={}",
                fixture.base_cost_wad,
                fixture.fee_wad
            );
            // ...and the on-chain implementation agrees with the fixture.
            assert_eq!(
                actual_fee_base, fixture.expected_fee_base,
                "baseCostWad={} feeWad={}",
                fixture.base_cost_wad, fixture.fee_wad
            );
        }
    }

    #[test]
    fn fee_rounding_golden_includes_floor_on_sum_dust_cases() {
        // Guards the fixture set itself: if someone "simplifies" these to cases
        // where floor-on-sum and floor-of-fee agree, the test above stops
        // discriminating between the two rules and silently passes on a wrong
        // implementation.
        let differs_from_separate_floor = FIXTURES.iter().filter(|fixture| {
            let separate_floor_fee = fixture.fee_wad / BASE_UNIT_WAD;
            fixture.expected_fee_base as u128 != separate_floor_fee
        });
        assert!(differs_from_separate_floor.count() >= 6);
    }

    #[test]
    fn fee_rounding_golden_rejects_sub_base_unit_total_pull() {
        // A total pull that floors to zero base units must be refused rather
        // than silently charging nothing.
        for (base_cost_wad, fee_wad) in [(1, 1), (BASE_UNIT_WAD - 2, 1)] {
            assert!(compute_taker_pull_from_fee_wad(base_cost_wad, fee_wad).is_err());
        }
    }

    // ── AMM fee math ──────────────────────────────────────────────────────
    //
    // Ported from main's sooth_amm/tests/fee_math.rs. Pins the
    // trade_positions boundary, shared verbatim with EVM
    // `FeeRouter._quoteFee`: fee_wad = cost_wad * fee_bps / 10_000 (floor),
    // then ceil to USDC.

    fn amm_fee_wad(cost_wad: u128, fee_bps: u16) -> u128 {
        cost_wad
            .checked_mul(fee_bps as u128)
            .unwrap()
            .checked_div(BPS_DENOMINATOR)
            .unwrap()
    }

    #[test]
    fn amm_fee_is_floor_divided() {
        // 1 wad at 1 bp = 1e14 exactly.
        assert_eq!(amm_fee_wad(crate::math::WAD_U, 1), crate::math::WAD_U / 10_000);
        // Sub-bps dust floors to zero rather than rounding up.
        assert_eq!(amm_fee_wad(9_999, 1), 0);
        assert_eq!(amm_fee_wad(10_000, 1), 1);
    }

    #[test]
    fn amm_fee_zero_bps_is_free() {
        assert_eq!(amm_fee_wad(crate::math::WAD_U, 0), 0);
    }

    #[test]
    fn amm_fee_full_bps_is_whole_cost() {
        assert_eq!(
            amm_fee_wad(crate::math::WAD_U, 10_000),
            crate::math::WAD_U
        );
    }

    #[test]
    fn compute_taker_pull_matches_manual_bps_math() {
        // Ties the bps path to the golden floor-on-sum path: the fee derived
        // from bps must round identically to the fee handed in directly.
        let cost_wad = 7 * BASE_UNIT_WAD + 123_456_789;
        let fee_bps = 100u16; // 1%
        let (_, fee_from_bps, _) = compute_taker_pull(cost_wad, fee_bps).unwrap();
        let (_, fee_from_wad, _) =
            compute_taker_pull_from_fee_wad(cost_wad, amm_fee_wad(cost_wad, fee_bps)).unwrap();
        assert_eq!(fee_from_bps, fee_from_wad);
    }
}
