use crate::error::CoreError;
use anchor_lang::{require, Result};
use rust_decimal::prelude::*;
use rust_decimal::Decimal;

pub const PRICE_WAD: u128 = 1_000_000_000_000_000_000;
pub const PRICE_TICK: u128 = 1_000_000_000_000_000;

/// Cost for a YES share at a probability-WAD price.
pub fn calculate_for_cost_from_stake(stake: u64, price: u128) -> u64 {
    ((stake as u128) * price / PRICE_WAD) as u64
}

/// Risk for a NO/against share at a probability-WAD YES price.
pub fn calculate_risk_from_stake(stake: u64, price: u128) -> u64 {
    ((stake as u128) * (PRICE_WAD - price) / PRICE_WAD) as u64
}

/// A matched share pays one unit if its side wins.
pub fn calculate_for_payout(stake: u64, _price: u128) -> u64 {
    stake
}

pub fn calculate_stake_from_payout(payout: u64, _price: u128) -> u64 {
    payout
}

pub fn price_precision_is_within_range(price: u128) -> Result<()> {
    require!(price % PRICE_TICK == 0, CoreError::PricePrecisionTooLarge);
    Ok(())
}

pub fn stake_precision_is_within_range(stake: u64, decimal_limit: u8) -> Result<bool> {
    let mut stake_decimal = Decimal::from_u64(stake).unwrap();
    require!(
        stake_decimal.set_scale(decimal_limit as u32).is_ok(),
        CoreError::ArithmeticError
    );
    Ok(stake_decimal.fract().is_zero())
}

#[cfg(test)]
pub const fn odds_to_probability_wad(odds_scaled: u128, scale: u128) -> u128 {
    PRICE_WAD * scale / odds_scaled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_price_precision_is_within_range() {
        assert!(price_precision_is_within_range(PRICE_TICK).is_ok());
        assert!(price_precision_is_within_range(400 * PRICE_TICK).is_ok());
        assert!(price_precision_is_within_range(999 * PRICE_TICK).is_ok());
        assert!(price_precision_is_within_range(PRICE_TICK + 1).is_err());
    }

    #[test]
    fn test_decimal_odds_fixture_translation() {
        assert_eq!(odds_to_probability_wad(25, 10), 400 * PRICE_TICK);
    }

    #[test]
    fn test_calculate_for_cost_from_stake() {
        assert_eq!(calculate_for_cost_from_stake(100, 400 * PRICE_TICK), 40);
        assert_eq!(calculate_for_cost_from_stake(1000, 250 * PRICE_TICK), 250);
    }

    #[test]
    fn test_calculate_against_risk_from_stake() {
        assert_eq!(calculate_risk_from_stake(100, 400 * PRICE_TICK), 60);
        assert_eq!(calculate_risk_from_stake(1000, 250 * PRICE_TICK), 750);
    }

    #[test]
    fn test_calculate_for_payout() {
        assert_eq!(calculate_for_payout(100, 400 * PRICE_TICK), 100);
        assert_eq!(calculate_for_payout(1000, 250 * PRICE_TICK), 1000);
    }

    #[test]
    fn test_calculate_stake_from_payout() {
        assert_eq!(calculate_stake_from_payout(300, 400 * PRICE_TICK), 300);
        assert_eq!(calculate_stake_from_payout(322, 250 * PRICE_TICK), 322);
    }

    #[test]
    fn test_stake_precision_is_within_range_failure() {
        assert!(!stake_precision_is_within_range(1, 3).unwrap());
        assert!(!stake_precision_is_within_range(1001, 3).unwrap());
        assert!(!stake_precision_is_within_range(1010, 3).unwrap());
        assert!(!stake_precision_is_within_range(1100, 3).unwrap());
        assert!(!stake_precision_is_within_range(u64::MAX, 3).unwrap());
    }

    #[test]
    fn test_stake_precision_is_within_range_success() {
        assert!(stake_precision_is_within_range(0, 3).unwrap());
        assert!(stake_precision_is_within_range(1000, 3).unwrap());
        assert!(stake_precision_is_within_range(10000, 3).unwrap());
        assert!(stake_precision_is_within_range(100000, 3).unwrap());

        let test_case = (u64::MAX / 1000) * 1000;
        assert!(stake_precision_is_within_range(test_case, 3).unwrap());
    }
}
