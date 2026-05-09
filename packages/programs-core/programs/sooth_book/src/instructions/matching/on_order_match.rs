use crate::error::CoreError;
use crate::events::trade::TradeEvent;
use crate::instructions::matching::create_trade::create_trade;
use crate::instructions::{current_timestamp, market_position};
use crate::state::market_account::Market;
use crate::state::market_matching_pool_account::MarketMatchingPool;
use crate::state::market_matching_queue_account::MarketMatchingQueue;
use crate::state::market_position_account::MarketPosition;
use crate::state::order_account::Order;
use crate::state::trade_account::Trade;
use anchor_lang::prelude::*;

use super::update_matching_pool_with_matched_order;

pub fn on_order_match_taker(
    market_pk: &Pubkey,
    market: &mut Market,
    market_matching_queue: &mut MarketMatchingQueue,
    order_pk: &Pubkey,
    order: &mut Order,
    order_trade: &mut Trade,
    payer: &Pubkey,
) -> Result<()> {
    require!(!order.is_completed(), CoreError::StatusClosed);

    let now = current_timestamp();

    match market_matching_queue.matches.peek_mut() {
        None => Err(error!(CoreError::MatchingQueueIsEmpty)),
        Some(order_match) => {
            let matched_stake = order_match.stake;
            let matched_price = order_match.price;

            create_trade(
                order_trade,
                &order.purchaser,
                &order.market,
                order_pk,
                order.market_outcome_index,
                order.for_outcome,
                matched_stake,
                matched_price,
                now,
                *payer,
            );
            market.increment_unclosed_accounts_count()?;

            emit!(TradeEvent {
                amount: matched_stake,
                price: matched_price,
                market: *market_pk,
            });

            // dequeue empty matches (needs to be last due to borrowing)
            market_matching_queue.matches.dequeue();

            Ok(())
        }
    }
}

pub fn on_order_match_maker(
    market: &mut Market,
    market_matching_queue: &mut MarketMatchingQueue,
    market_matching_pool: &mut MarketMatchingPool,
    order_pk: &Pubkey,
    order: &mut Order,
    market_position: &mut MarketPosition,
    order_trade: &mut Trade,
    payer: &Pubkey,
) -> Result<u64> {
    require!(!order.is_completed(), CoreError::StatusClosed);

    let now = current_timestamp();

    match market_matching_queue.matches.peek_mut() {
        None => Err(error!(CoreError::MatchingQueueIsEmpty)),
        Some(order_match) => {
            let matched_stake = order.stake_unmatched.min(order_match.stake);
            let matched_price = order_match.price;

            // update order
            order.match_stake_unmatched(matched_stake, matched_price)?;
            let refund = market_position::update_on_order_match(
                market_position,
                order,
                matched_stake,
                matched_price,
            )?;
            update_matching_pool_with_matched_order(
                market_matching_pool,
                matched_stake,
                *order_pk,
                order.stake_unmatched == 0_u64,
            )?;

            // update order match
            order_match.stake = order_match
                .stake
                .checked_sub(matched_stake)
                .ok_or(CoreError::MatchingMatchedStakeCalculationError)?;

            // store maker trade
            create_trade(
                order_trade,
                &order.purchaser,
                &order.market,
                order_pk,
                order.market_outcome_index,
                order.for_outcome,
                matched_stake,
                matched_price,
                now,
                *payer,
            );
            market.increment_unclosed_accounts_count()?;

            // dequeue empty matches (needs to be last due to borrowing)
            if order_match.stake == 0_u64 {
                market_matching_queue.matches.dequeue();
            }

            Ok(refund)
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::state::{
        market_account::{MarketOrderBehaviour, MarketStatus},
        market_matching_pool_account::Cirque,
        market_matching_queue_account::{MatchingQueue, OrderMatch},
        market_order_request_queue::mock_order_request,
        order_account::{mock_order_from_order_request, OrderStatus},
    };

    #[test]
    fn error_empty_queue() {
        let market_pk = Pubkey::new_unique();
        let mut market = mock_market();
        let market_outcome_index = 1;
        let matched_price = 455 * crate::instructions::PRICE_TICK;
        let payer_pk = Pubkey::new_unique();

        let order_request = mock_order_request(
            Pubkey::new_unique(),
            false,
            market_outcome_index,
            100_u64,
            417 * crate::instructions::PRICE_TICK,
        );
        let order_pk = Pubkey::new_unique();
        let mut order = mock_order_from_order_request(market_pk, order_request, payer_pk);

        let mut market_position = mock_market_position(market_pk, order_request.purchaser, 3);
        let update_on_order_creation = market_position::update_on_order_request_creation(
            &mut market_position,
            order_request.market_outcome_index,
            order_request.for_outcome,
            order_request.stake,
            order_request.expected_price,
        );
        assert!(update_on_order_creation.is_ok());
        assert_eq!(vec!(0, 58, 0), market_position.unmatched_exposures);

        let mut market_matching_pool = MarketMatchingPool {
            market: market_pk,
            market_outcome_index,
            for_outcome: false,
            price: matched_price,
            liquidity_amount: 100_u64,
            matched_amount: 0_u64,
            orders: Cirque::new(1),
            payer: payer_pk,
        };
        market_matching_pool.orders.enqueue(order_pk);
        assert_eq!(1_u32, market_matching_pool.orders.len());

        let mut market_matching_queue = MarketMatchingQueue {
            market: market_pk,
            matches: MatchingQueue::new(10),
        };

        let mut maker_order_trade = Trade::default();

        let on_order_match_testable_result = on_order_match_maker(
            &mut market,
            &mut market_matching_queue,
            &mut market_matching_pool,
            &order_pk,
            &mut order,
            &mut market_position,
            &mut maker_order_trade,
            &payer_pk,
        );
        assert!(on_order_match_testable_result.is_err());
        assert_eq!(
            error!(CoreError::MatchingQueueIsEmpty),
            on_order_match_testable_result.unwrap_err()
        );

        assert_eq!(100_u64, order.stake_unmatched);
        assert_eq!(0_u64, order.payout);
        assert_eq!(417 * crate::instructions::PRICE_TICK, order.expected_price);

        assert_eq!(vec!(0, 58, 0), market_position.unmatched_exposures);
        assert_eq!(vec!(0, 0, 0), market_position.market_outcome_sums);

        assert_eq!(100_u64, market_matching_pool.liquidity_amount);
        assert_eq!(0_u64, market_matching_pool.matched_amount);
        assert_eq!(1_u32, market_matching_pool.orders.len());

        assert_eq!(false, maker_order_trade.for_outcome); // default value
        assert_eq!(0_u64, maker_order_trade.stake); // default value
        assert_eq!(0, maker_order_trade.price); // default value
    }

    #[test]
    fn match_less_than() {
        let market_pk = Pubkey::new_unique();
        let mut market = mock_market();
        let market_outcome_index = 1;
        let matched_price = 455 * crate::instructions::PRICE_TICK;
        let matched_stake = 10_u64;
        let payer_pk = Pubkey::new_unique();

        let order_request = mock_order_request(
            Pubkey::new_unique(),
            false,
            market_outcome_index,
            100_u64,
            417 * crate::instructions::PRICE_TICK,
        );
        let order_pk = Pubkey::new_unique();
        let mut order = mock_order_from_order_request(market_pk, order_request, payer_pk);

        let mut market_position = mock_market_position(market_pk, order_request.purchaser, 3);
        let update_on_order_creation = market_position::update_on_order_request_creation(
            &mut market_position,
            order_request.market_outcome_index,
            order_request.for_outcome,
            order_request.stake,
            order_request.expected_price,
        );
        assert!(update_on_order_creation.is_ok());
        assert_eq!(vec!(0, 58, 0), market_position.unmatched_exposures);

        let mut market_matching_pool = MarketMatchingPool {
            market: market_pk,
            market_outcome_index,
            for_outcome: false,
            price: matched_price,
            liquidity_amount: 100_u64,
            matched_amount: 0_u64,
            orders: Cirque::new(1),
            payer: payer_pk,
        };
        market_matching_pool.orders.enqueue(order_pk);
        assert_eq!(1_u32, market_matching_pool.orders.len());

        let mut market_matching_queue = MarketMatchingQueue {
            market: market_pk,
            matches: MatchingQueue::new(10),
        };
        market_matching_queue.matches.enqueue(OrderMatch::maker(
            true,
            market_outcome_index,
            matched_price,
            matched_stake,
        ));

        let mut maker_order_trade = Trade::default();

        let on_order_match_testable_result = on_order_match_maker(
            &mut market,
            &mut market_matching_queue,
            &mut market_matching_pool,
            &order_pk,
            &mut order,
            &mut market_position,
            &mut maker_order_trade,
            &payer_pk,
        );
        assert!(on_order_match_testable_result.is_ok());

        assert_eq!(90_u64, order.stake_unmatched);
        assert_eq!(10_u64, order.payout);
        assert_eq!(417 * crate::instructions::PRICE_TICK, order.expected_price);

        assert_eq!(vec!(0, 53, 0), market_position.unmatched_exposures);
        assert_eq!(vec!(5, -5, 5), market_position.market_outcome_sums);

        assert_eq!(90_u64, market_matching_pool.liquidity_amount);
        assert_eq!(10_u64, market_matching_pool.matched_amount);
        assert_eq!(1_u32, market_matching_pool.orders.len());

        assert_eq!(false, maker_order_trade.for_outcome);
        assert_eq!(10_u64, maker_order_trade.stake);
        assert_eq!(
            455 * crate::instructions::PRICE_TICK,
            maker_order_trade.price
        );
    }

    #[test]
    fn match_greater_than() {
        let market_pk = Pubkey::new_unique();
        let mut market = mock_market();
        let market_outcome_index = 1;
        let matched_price = 455 * crate::instructions::PRICE_TICK;
        let matched_stake = 100_u64;
        let payer_pk = Pubkey::new_unique();

        let order_request = mock_order_request(
            Pubkey::new_unique(),
            false,
            market_outcome_index,
            10_u64,
            417 * crate::instructions::PRICE_TICK,
        );
        let order_pk = Pubkey::new_unique();
        let mut order = mock_order_from_order_request(market_pk, order_request, payer_pk);

        let mut market_position = mock_market_position(market_pk, order_request.purchaser, 3);
        let update_on_order_creation = market_position::update_on_order_request_creation(
            &mut market_position,
            order_request.market_outcome_index,
            order_request.for_outcome,
            order_request.stake,
            order_request.expected_price,
        );
        assert!(update_on_order_creation.is_ok());
        assert_eq!(vec!(0, 5, 0), market_position.unmatched_exposures);

        let mut market_matching_pool = MarketMatchingPool {
            market: market_pk,
            market_outcome_index,
            for_outcome: false,
            price: matched_price,
            liquidity_amount: 10_u64,
            matched_amount: 0_u64,
            orders: Cirque::new(1),
            payer: payer_pk,
        };
        market_matching_pool.orders.enqueue(order_pk);
        assert_eq!(1_u32, market_matching_pool.orders.len());

        let mut market_matching_queue = MarketMatchingQueue {
            market: market_pk,
            matches: MatchingQueue::new(10),
        };
        market_matching_queue.matches.enqueue(OrderMatch::maker(
            true,
            market_outcome_index,
            matched_price,
            matched_stake,
        ));

        let mut maker_order_trade = Trade::default();

        let on_order_match_testable_result = on_order_match_maker(
            &mut market,
            &mut market_matching_queue,
            &mut market_matching_pool,
            &order_pk,
            &mut order,
            &mut market_position,
            &mut maker_order_trade,
            &payer_pk,
        );
        assert!(on_order_match_testable_result.is_ok());

        assert_eq!(0_u64, order.stake_unmatched);
        assert_eq!(10_u64, order.payout);
        assert_eq!(417 * crate::instructions::PRICE_TICK, order.expected_price);

        assert_eq!(vec!(0, 0, 0), market_position.unmatched_exposures);
        assert_eq!(vec!(5, -5, 5), market_position.market_outcome_sums);

        assert_eq!(0_u64, market_matching_pool.liquidity_amount);
        assert_eq!(10_u64, market_matching_pool.matched_amount);
        assert_eq!(0_u32, market_matching_pool.orders.len());

        assert_eq!(false, maker_order_trade.for_outcome);
        assert_eq!(10_u64, maker_order_trade.stake);
        assert_eq!(
            455 * crate::instructions::PRICE_TICK,
            maker_order_trade.price
        );
    }

    #[test]
    fn test_invalid_order_status() {
        let market_pk = Pubkey::new_unique();
        let mut market = mock_market();
        let market_outcome_index = 1;
        let matched_price = 455 * crate::instructions::PRICE_TICK;
        let payer_pk = Pubkey::new_unique();

        let order_request = mock_order_request(
            Pubkey::new_unique(),
            false,
            market_outcome_index,
            100_u64,
            417 * crate::instructions::PRICE_TICK,
        );
        let order_pk = Pubkey::new_unique();
        let mut order = mock_order_from_order_request(market_pk, order_request, payer_pk);
        order.order_status = OrderStatus::Voided;

        let mut market_position = mock_market_position(market_pk, order_request.purchaser, 3);

        let mut market_matching_pool = MarketMatchingPool {
            market: market_pk,
            market_outcome_index,
            for_outcome: false,
            price: matched_price,
            liquidity_amount: 100_u64,
            matched_amount: 0_u64,
            orders: Cirque::new(1),
            payer: payer_pk,
        };
        market_matching_pool.orders.enqueue(order_pk);

        let mut market_matching_queue = MarketMatchingQueue {
            market: market_pk,
            matches: MatchingQueue::new(10),
        };

        let mut maker_order_trade = Trade::default();

        let result_maker = on_order_match_maker(
            &mut market,
            &mut market_matching_queue,
            &mut market_matching_pool,
            &order_pk,
            &mut order,
            &mut market_position,
            &mut maker_order_trade,
            &payer_pk,
        );
        assert!(result_maker.is_err());
        assert_eq!(error!(CoreError::StatusClosed), result_maker.unwrap_err());

        let result_taker = on_order_match_taker(
            &market_pk,
            &mut market,
            &mut market_matching_queue,
            &order_pk,
            &mut order,
            &mut maker_order_trade,
            &payer_pk,
        );
        assert!(result_taker.is_err());
        assert_eq!(error!(CoreError::StatusClosed), result_taker.unwrap_err());
    }

    fn mock_market() -> Market {
        Market {
            authority: Default::default(),
            event_account: Default::default(),
            mint_account: Default::default(),
            market_status: MarketStatus::Open,
            market_type: Default::default(),
            market_type_discriminator: None,
            market_type_value: None,
            version: 0,
            decimal_limit: 0,
            published: false,
            suspended: false,
            market_outcomes_count: 0,
            market_winning_outcome_index: None,
            market_lock_timestamp: 0,
            market_settle_timestamp: None,
            market_lock_order_behaviour: MarketOrderBehaviour::None,
            title: "".to_string(),
            unsettled_accounts_count: 0,
            unclosed_accounts_count: 0,
            escrow_account_bump: 0,
            funding_account_bump: 0,
            event_start_timestamp: 100,
        }
    }

    fn mock_market_position(market_pk: Pubkey, purchaser_pk: Pubkey, len: usize) -> MarketPosition {
        let mut market_position = MarketPosition::default();
        market_position.market = market_pk;
        market_position.purchaser = purchaser_pk;
        market_position.market_outcome_sums.resize(len, 0_i128);
        market_position.unmatched_exposures.resize(len, 0_u64);
        return market_position;
    }
}
