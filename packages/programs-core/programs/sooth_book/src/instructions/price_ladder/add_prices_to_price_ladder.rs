use crate::instructions::{price_precision_is_within_range, PRICE_WAD};
use crate::state::price_ladder::PriceLadder;
use crate::CoreError;
use anchor_lang::{require, Result};

pub fn add_prices_to_price_ladder(
    price_ladder: &mut PriceLadder,
    prices_to_add: Vec<u128>,
) -> Result<()> {
    validate_prices(&prices_to_add)?;

    let mut prices = price_ladder.prices.clone();
    prices.extend(prices_to_add);
    prices.sort_unstable();
    prices.dedup();

    require!(
        prices.len() <= price_ladder.max_number_of_prices as usize,
        CoreError::PriceLadderIsFull
    );

    price_ladder.prices = prices;

    Ok(())
}

pub fn remove_prices_from_price_ladder(
    price_ladder: &mut PriceLadder,
    prices_to_remove: Vec<u128>,
) -> Result<()> {
    for price in &prices_to_remove {
        if let Some(index) = price_ladder.prices.iter().position(|x| x == price) {
            price_ladder.prices.remove(index);
        }
    }
    Ok(())
}

fn validate_prices(prices: &[u128]) -> Result<()> {
    let prices_iter = prices.iter();
    for price in prices_iter {
        price_precision_is_within_range(*price)?;
        require!(*price > 0 && *price < PRICE_WAD, CoreError::PriceOneOrLess);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instructions::PRICE_TICK;
    use anchor_lang::error;
    use solana_program::pubkey::Pubkey;

    #[test]
    fn fill_with_valid_prices() {
        let price_ladder = &mut price_ladder();
        let new_prices = vec![100 * PRICE_TICK, 200 * PRICE_TICK, 300 * PRICE_TICK];
        let result = add_prices_to_price_ladder(price_ladder, new_prices);
        assert!(result.is_ok());
        assert_eq!(
            price_ladder.prices,
            vec![100 * PRICE_TICK, 200 * PRICE_TICK, 300 * PRICE_TICK]
        );
    }

    #[test]
    fn remove_success() {
        let price_ladder = &mut PriceLadder {
            prices: vec![
                100 * PRICE_TICK,
                200 * PRICE_TICK,
                300 * PRICE_TICK,
                400 * PRICE_TICK,
                500 * PRICE_TICK,
            ],
            max_number_of_prices: 5,
            authority: Pubkey::new_unique(),
        };

        let remove_first_result =
            remove_prices_from_price_ladder(price_ladder, vec![100 * PRICE_TICK]);
        assert!(remove_first_result.is_ok());
        assert_eq!(
            price_ladder.prices,
            vec![
                200 * PRICE_TICK,
                300 * PRICE_TICK,
                400 * PRICE_TICK,
                500 * PRICE_TICK
            ]
        );

        let remove_last_result =
            remove_prices_from_price_ladder(price_ladder, vec![500 * PRICE_TICK]);
        assert!(remove_last_result.is_ok());
        assert_eq!(
            price_ladder.prices,
            vec![200 * PRICE_TICK, 300 * PRICE_TICK, 400 * PRICE_TICK]
        );

        let remove_multiple_and_non_existant = remove_prices_from_price_ladder(
            price_ladder,
            vec![
                PRICE_WAD,
                200 * PRICE_TICK,
                400 * PRICE_TICK,
                600 * PRICE_TICK,
            ],
        );
        assert!(remove_multiple_and_non_existant.is_ok());
        assert_eq!(price_ladder.prices, vec![300 * PRICE_TICK]);
    }

    #[test]
    fn fill_with_invalid_price() {
        let price_ladder = &mut price_ladder();
        const EXPECTED_PRICES: Vec<u128> = vec![];

        let price_of_one_result = add_prices_to_price_ladder(
            price_ladder,
            vec![100 * PRICE_TICK, PRICE_WAD, 300 * PRICE_TICK],
        );
        assert!(price_of_one_result.is_err());
        assert_eq!(
            price_of_one_result.err(),
            Some(error!(CoreError::PriceOneOrLess))
        );
        assert_eq!(price_ladder.prices, EXPECTED_PRICES);

        let price_less_than_one_result =
            add_prices_to_price_ladder(price_ladder, vec![100 * PRICE_TICK, 0, 300 * PRICE_TICK]);
        assert!(price_less_than_one_result.is_err());
        assert_eq!(
            price_less_than_one_result.err(),
            Some(error!(CoreError::PriceOneOrLess))
        );
        assert_eq!(price_ladder.prices, EXPECTED_PRICES);

        let price_too_precise_result = add_prices_to_price_ladder(
            price_ladder,
            vec![100 * PRICE_TICK, PRICE_TICK + 1, 300 * PRICE_TICK],
        );
        assert!(price_too_precise_result.is_err());
        assert_eq!(
            price_too_precise_result.err(),
            Some(error!(CoreError::PricePrecisionTooLarge))
        );
        assert_eq!(price_ladder.prices, EXPECTED_PRICES);
    }

    #[test]
    fn over_fill() {
        let price_ladder = &mut price_ladder();

        let over_fill_at_once = add_prices_to_price_ladder(
            price_ladder,
            vec![
                100 * PRICE_TICK,
                200 * PRICE_TICK,
                300 * PRICE_TICK,
                400 * PRICE_TICK,
            ],
        );
        assert!(over_fill_at_once.is_err());
        assert_eq!(
            over_fill_at_once.err(),
            Some(error!(CoreError::PriceLadderIsFull))
        );
        assert_eq!(price_ladder.prices, vec![] as Vec<u128>);

        add_prices_to_price_ladder(
            price_ladder,
            vec![100 * PRICE_TICK, 200 * PRICE_TICK, 300 * PRICE_TICK],
        )
        .expect("Should have filled successfully");
        let fill_up_then_over_fill =
            add_prices_to_price_ladder(price_ladder, vec![400 * PRICE_TICK]);
        assert!(fill_up_then_over_fill.is_err());
        assert_eq!(
            fill_up_then_over_fill.err(),
            Some(error!(CoreError::PriceLadderIsFull))
        );
        assert_eq!(
            price_ladder.prices,
            vec![100 * PRICE_TICK, 200 * PRICE_TICK, 300 * PRICE_TICK]
        );
    }

    #[test]
    fn handle_duplicates() {
        let price_ladder = &mut price_ladder();

        assert!(add_prices_to_price_ladder(price_ladder, vec![100 * PRICE_TICK]).is_ok());
        assert_eq!(price_ladder.prices, vec![100 * PRICE_TICK]);
        assert!(add_prices_to_price_ladder(price_ladder, vec![100 * PRICE_TICK]).is_ok());
        assert_eq!(price_ladder.prices, vec![100 * PRICE_TICK]);

        assert!(
            add_prices_to_price_ladder(price_ladder, vec![100 * PRICE_TICK, 200 * PRICE_TICK])
                .is_ok()
        );
        assert_eq!(
            price_ladder.prices,
            vec![100 * PRICE_TICK, 200 * PRICE_TICK]
        );
        assert!(
            add_prices_to_price_ladder(price_ladder, vec![100 * PRICE_TICK, 200 * PRICE_TICK])
                .is_ok()
        );
        assert_eq!(
            price_ladder.prices,
            vec![100 * PRICE_TICK, 200 * PRICE_TICK]
        );

        assert!(add_prices_to_price_ladder(
            price_ladder,
            vec![100 * PRICE_TICK, 200 * PRICE_TICK, 300 * PRICE_TICK]
        )
        .is_ok());
        assert_eq!(
            price_ladder.prices,
            vec![100 * PRICE_TICK, 200 * PRICE_TICK, 300 * PRICE_TICK]
        );
        assert!(add_prices_to_price_ladder(
            price_ladder,
            vec![100 * PRICE_TICK, 200 * PRICE_TICK, 300 * PRICE_TICK]
        )
        .is_ok());
        assert_eq!(
            price_ladder.prices,
            vec![100 * PRICE_TICK, 200 * PRICE_TICK, 300 * PRICE_TICK]
        );

        assert!(add_prices_to_price_ladder(price_ladder, vec![100 * PRICE_TICK]).is_ok());
        assert_eq!(
            price_ladder.prices,
            vec![100 * PRICE_TICK, 200 * PRICE_TICK, 300 * PRICE_TICK]
        );
        assert!(add_prices_to_price_ladder(price_ladder, vec![200 * PRICE_TICK]).is_ok());
        assert_eq!(
            price_ladder.prices,
            vec![100 * PRICE_TICK, 200 * PRICE_TICK, 300 * PRICE_TICK]
        );
        assert!(add_prices_to_price_ladder(price_ladder, vec![300 * PRICE_TICK]).is_ok());
        assert_eq!(
            price_ladder.prices,
            vec![100 * PRICE_TICK, 200 * PRICE_TICK, 300 * PRICE_TICK]
        );
    }

    fn price_ladder() -> PriceLadder {
        PriceLadder {
            prices: vec![],
            max_number_of_prices: 3,
            authority: Pubkey::new_unique(),
        }
    }
}
