use anchor_lang::prelude::*;

use crate::error::CoreError;
use crate::error::CoreError::MatchingQueueIsFull;
use crate::state::market_liquidities::MarketLiquidities;
use crate::state::market_matching_queue_account::*;
use crate::state::order_account::*;

#[cfg(test)]
use crate::state::market_liquidities::MarketOutcomePriceLiquidity;

pub const MATCH_CAPACITY: usize = 10_usize; // an arbitrary number

pub fn on_order_creation(
    market_liquidities: &mut MarketLiquidities,
    market_matching_queue: &mut MarketMatchingQueue,
    order_pk: &Pubkey,
    order: &mut Order,
) -> Result<Vec<(u64, u128)>> {
    match order.for_outcome {
        true => match_for_order(market_liquidities, market_matching_queue, order_pk, order),
        false => match_against_order(market_liquidities, market_matching_queue, order_pk, order),
    }
}

fn match_for_order(
    market_liquidities: &mut MarketLiquidities,
    market_matching_queue: &mut MarketMatchingQueue,
    order_pk: &Pubkey,
    order: &mut Order,
) -> Result<Vec<(u64, u128)>> {
    let mut order_matches = Vec::with_capacity(MATCH_CAPACITY);
    let order_outcome = order.market_outcome_index;

    // FOR order matches AGAINST liquidity.
    for liquidity in market_liquidities
        .liquidities_against
        .iter()
        .filter(|element| element.outcome == order_outcome)
    {
        if order.stake_unmatched == 0_u64 || order_matches.len() == order_matches.capacity() {
            break;
        }
        if liquidity.price < order.expected_price {
            break; // liquidity.price >= expected_price must be true
        }

        let stake_matched = liquidity.liquidity.min(order.stake_unmatched);
        order_matches.push((liquidity.price, stake_matched));

        if stake_matched == 0_u64 {
            continue;
        }

        market_matching_queue
            .matches
            .enqueue(OrderMatch::maker(
                !order.for_outcome,
                order.market_outcome_index,
                liquidity.price,
                stake_matched,
            ))
            .ok_or(MatchingQueueIsFull)?;

        market_matching_queue
            .matches
            .enqueue(OrderMatch::taker(
                *order_pk,
                order.for_outcome,
                order.market_outcome_index,
                liquidity.price,
                stake_matched,
            ))
            .ok_or(MatchingQueueIsFull)?;

        order
            .match_stake_unmatched(stake_matched, liquidity.price)
            .map_err(|_| CoreError::MatchingPayoutAmountError)?;
    }

    for (price, stake) in &order_matches {
        require_eq!(
            market_liquidities
                .remove_liquidity_against(order.market_outcome_index, *price, *stake)
                .map_err(|_| CoreError::MatchingRemainingLiquidityTooSmall)?,
            *stake,
            CoreError::MatchingRemainingLiquidityTooSmall
        );
        market_liquidities.update_stake_matched_total(*stake)?;
    }

    if order.stake_unmatched > 0_u64 {
        market_liquidities.add_liquidity_for(
            order.market_outcome_index,
            order.expected_price,
            order.stake_unmatched,
        )?;
    }

    Ok(order_matches
        .iter()
        .filter(|(_, stake)| *stake > 0)
        .map(|(price, stake)| (*stake, *price))
        .collect())
}

fn match_against_order(
    market_liquidities: &mut MarketLiquidities,
    market_matching_queue: &mut MarketMatchingQueue,
    order_pk: &Pubkey,
    order: &mut Order,
) -> Result<Vec<(u64, u128)>> {
    let mut order_matches = Vec::with_capacity(MATCH_CAPACITY);
    let order_outcome = order.market_outcome_index;

    // AGAINST order matches FOR liquidity.
    for liquidity in market_liquidities
        .liquidities_for
        .iter()
        .filter(|element| element.outcome == order_outcome)
    {
        if order.stake_unmatched == 0_u64 || order_matches.len() == order_matches.capacity() {
            break;
        }
        if liquidity.price > order.expected_price {
            break; // liquidity.price <= expected_price must be true
        }

        let stake_matched = liquidity.liquidity.min(order.stake_unmatched);
        order_matches.push((liquidity.price, stake_matched));

        if stake_matched == 0_u64 {
            continue;
        }

        market_matching_queue
            .matches
            .enqueue(OrderMatch::maker(
                !order.for_outcome,
                order.market_outcome_index,
                liquidity.price,
                stake_matched,
            ))
            .ok_or(MatchingQueueIsFull)?;

        market_matching_queue
            .matches
            .enqueue(OrderMatch::taker(
                *order_pk,
                order.for_outcome,
                order.market_outcome_index,
                liquidity.price,
                stake_matched,
            ))
            .ok_or(MatchingQueueIsFull)?;

        order
            .match_stake_unmatched(stake_matched, liquidity.price)
            .map_err(|_| CoreError::MatchingPayoutAmountError)?;
    }

    for (price, stake) in &order_matches {
        require_eq!(
            market_liquidities
                .remove_liquidity_for(order.market_outcome_index, *price, *stake)
                .map_err(|_| CoreError::MatchingRemainingLiquidityTooSmall)?,
            *stake,
            CoreError::MatchingRemainingLiquidityTooSmall
        );
        market_liquidities.update_stake_matched_total(*stake)?;
    }

    if order.stake_unmatched > 0_u64 {
        market_liquidities.add_liquidity_against(
            order.market_outcome_index,
            order.expected_price,
            order.stake_unmatched,
        )?;
    }

    Ok(order_matches
        .iter()
        .filter(|(_, stake)| *stake > 0)
        .map(|(price, stake)| (*stake, *price))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::market_liquidities::mock_market_liquidities;
    use crate::state::market_matching_queue_account::{MarketMatchingQueue, MatchingQueue};
    use crate::state::order_account::mock_order;
    use solana_program::pubkey::Pubkey;

    #[test]
    fn match_for_order_direct_liquidity() {
        let market_pk = Pubkey::new_unique();
        let payer_pk = Pubkey::new_unique();
        let order_pk = Pubkey::new_unique();
        let mut order = mock_order(
            market_pk,
            1,
            true,
            357 * crate::instructions::PRICE_TICK,
            100_000,
            payer_pk,
        );
        let mut market_liquidities = mock_market_liquidities(market_pk);
        market_liquidities
            .add_liquidity_against(1, 357 * crate::instructions::PRICE_TICK, 125_000)
            .unwrap();
        market_liquidities
            .add_liquidity_against(2, 357 * crate::instructions::PRICE_TICK, 125_000)
            .unwrap();

        let mut market_matching_queue = MarketMatchingQueue {
            market: market_pk,
            matches: MatchingQueue::new(10),
        };

        on_order_creation(
            &mut market_liquidities,
            &mut market_matching_queue,
            &order_pk,
            &mut order,
        )
        .expect("match_for_order");

        assert_eq!(
            Vec::<(u128, u64)>::new(),
            liquidities(&market_liquidities.liquidities_for)
        );
        assert_eq!(
            vec!(
                (357 * crate::instructions::PRICE_TICK, 125_000),
                (357 * crate::instructions::PRICE_TICK, 25_000)
            ),
            liquidities(&market_liquidities.liquidities_against)
        );
        assert_eq!(
            vec![
                (false, 357 * crate::instructions::PRICE_TICK, 100_000),
                (true, 357 * crate::instructions::PRICE_TICK, 100_000)
            ],
            matches(&market_matching_queue.matches)
        );
        assert_eq!(0_u64, order.stake_unmatched);
        assert_eq!(100_000_u64, order.payout);
    }

    #[test]
    fn match_against_order_direct_liquidity() {
        let market_pk = Pubkey::new_unique();
        let payer_pk = Pubkey::new_unique();
        let order_pk = Pubkey::new_unique();
        let mut order = mock_order(
            market_pk,
            1,
            false,
            357 * crate::instructions::PRICE_TICK,
            100_000,
            payer_pk,
        );
        let mut market_liquidities = mock_market_liquidities(market_pk);
        market_liquidities
            .add_liquidity_for(1, 357 * crate::instructions::PRICE_TICK, 125_000)
            .unwrap();
        market_liquidities
            .add_liquidity_for(2, 357 * crate::instructions::PRICE_TICK, 125_000)
            .unwrap();

        let mut market_matching_queue = MarketMatchingQueue {
            market: market_pk,
            matches: MatchingQueue::new(10),
        };

        on_order_creation(
            &mut market_liquidities,
            &mut market_matching_queue,
            &order_pk,
            &mut order,
        )
        .expect("match_against_order");

        assert_eq!(
            vec!(
                (357 * crate::instructions::PRICE_TICK, 25_000),
                (357 * crate::instructions::PRICE_TICK, 125_000)
            ),
            liquidities(&market_liquidities.liquidities_for)
        );
        assert_eq!(
            Vec::<(u128, u64)>::new(),
            liquidities(&market_liquidities.liquidities_against)
        );
        assert_eq!(
            vec![
                (true, 357 * crate::instructions::PRICE_TICK, 100_000),
                (false, 357 * crate::instructions::PRICE_TICK, 100_000)
            ],
            matches(&market_matching_queue.matches)
        );
        assert_eq!(0_u64, order.stake_unmatched);
        assert_eq!(100_000_u64, order.payout);
    }

    #[test]
    fn unmatched_remainder_is_added_to_liquidity() {
        let market_pk = Pubkey::new_unique();
        let payer_pk = Pubkey::new_unique();
        let order_pk = Pubkey::new_unique();
        let mut order = mock_order(
            market_pk,
            1,
            true,
            357 * crate::instructions::PRICE_TICK,
            100_000,
            payer_pk,
        );
        let mut market_liquidities = mock_market_liquidities(market_pk);
        market_liquidities
            .add_liquidity_against(1, 357 * crate::instructions::PRICE_TICK, 25_000)
            .unwrap();

        let mut market_matching_queue = MarketMatchingQueue {
            market: market_pk,
            matches: MatchingQueue::new(10),
        };

        on_order_creation(
            &mut market_liquidities,
            &mut market_matching_queue,
            &order_pk,
            &mut order,
        )
        .expect("match_for_order");

        assert_eq!(
            vec!((357 * crate::instructions::PRICE_TICK, 75_000)),
            liquidities(&market_liquidities.liquidities_for)
        );
        assert_eq!(
            Vec::<(u128, u64)>::new(),
            liquidities(&market_liquidities.liquidities_against)
        );
        assert_eq!(75_000_u64, order.stake_unmatched);
        assert_eq!(25_000_u64, order.payout);
    }
}

#[cfg(test)]
fn liquidities(liquidities: &Vec<MarketOutcomePriceLiquidity>) -> Vec<(u128, u64)> {
    liquidities
        .iter()
        .map(|v| (v.price, v.liquidity))
        .collect::<Vec<(u128, u64)>>()
}

#[cfg(test)]
fn matches(matches: &MatchingQueue) -> Vec<(bool, u128, u64)> {
    matches
        .to_vec()
        .iter()
        .map(|v| (v.for_outcome, v.price, v.stake))
        .collect::<Vec<(bool, u128, u64)>>()
}
