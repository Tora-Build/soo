use anchor_lang::prelude::*;

use crate::context::{CreateMarket, InitializeMarketOutcome};
use crate::instructions::{current_timestamp, price_precision_is_within_range, PRICE_WAD};
use crate::sooth_book::{PRICE_SCALE, SEED_SEPARATOR_CHAR};
use crate::state::market_account::{Market, MarketOrderBehaviour, MarketStatus};
use crate::state::market_matching_pool_account::{Cirque, MarketMatchingPool};
use crate::state::market_outcome_account::MarketOutcome;
use crate::state::order_account::Order;
use crate::CoreError;

const STATUSES_THAT_SUPPORT_MARKET_RECREATION: [MarketStatus; 2] =
    [MarketStatus::ReadyToVoid, MarketStatus::Voided];

#[allow(clippy::too_many_arguments)]
pub fn create(
    ctx: Context<CreateMarket>,
    sooth_market_pda: Pubkey,
    event_account: Pubkey,
    market_type: Pubkey,
    market_type_discriminator: Option<String>,
    market_type_value: Option<String>,
    title: String,
    max_decimals: u8,
    market_lock_timestamp: i64,
    event_start_timestamp: i64,
    market_lock_order_behaviour: MarketOrderBehaviour,
) -> Result<()> {
    require!(
        title.len() <= Market::TITLE_MAX_LENGTH,
        CoreError::MarketTitleTooLong
    );
    require!(
        market_lock_timestamp > current_timestamp(),
        CoreError::MarketLockTimeNotInTheFuture
    );
    require!(
        market_lock_timestamp <= event_start_timestamp,
        CoreError::MarketLockTimeAfterEventStartTime
    );
    require!(
        ctx.accounts.mint.decimals >= PRICE_SCALE,
        CoreError::MintDecimalsUnsupported
    );
    let decimal_limit = ctx.accounts.mint.decimals.saturating_sub(max_decimals);
    require!(PRICE_SCALE <= decimal_limit, CoreError::MaxDecimalsTooLarge);

    require!(
        ctx.accounts.market_type.requires_discriminator == market_type_discriminator.is_some(),
        CoreError::MarketTypeDiscriminatorUsageIncorrect
    );
    require!(
        ctx.accounts.market_type.requires_value == market_type_value.is_some(),
        CoreError::MarketTypeValueUsageIncorrect
    );

    require!(
        market_type_discriminator.is_none()
            || !market_type_discriminator
                .as_ref()
                .unwrap()
                .contains(SEED_SEPARATOR_CHAR),
        CoreError::MarketTypeDiscriminatorContainsSeedSeparator
    );

    let mut version = 0;
    if let Some(existing_market) = &ctx.accounts.existing_market {
        // check market status is OK to recreate
        require!(
            STATUSES_THAT_SUPPORT_MARKET_RECREATION.contains(&existing_market.market_status),
            CoreError::MarketInvalidStatus
        );

        // check seeds match
        require_keys_eq!(
            existing_market.event_account,
            event_account,
            CoreError::MarketEventAccountMismatch
        );
        require_keys_eq!(
            existing_market.market_type,
            market_type,
            CoreError::MarketTypeMismatch
        );
        require!(
            existing_market.market_type_discriminator == market_type_discriminator,
            CoreError::MarketTypeDiscriminatorMismatch
        );
        require!(
            existing_market.market_type_value == market_type_value,
            CoreError::MarketTypeValueMismatch
        );
        require_keys_eq!(
            existing_market.mint_account,
            ctx.accounts.mint.key(),
            CoreError::MarketMintMismatch
        );
        require_keys_eq!(
            existing_market.sooth_market_pda,
            sooth_market_pda,
            CoreError::MarketMismatch
        );

        // check authority matches
        require_eq!(
            existing_market.authority,
            ctx.accounts.market_operator.key(),
            CoreError::MarketAuthorityMismatch
        );

        version = existing_market.version + 1;
    }

    ctx.accounts.market.authority = ctx.accounts.market_operator.key();

    ctx.accounts.market.sooth_market_pda = sooth_market_pda;
    ctx.accounts.market.fee_b_base_wad = 0;
    ctx.accounts.market.event_account = event_account;
    ctx.accounts.market.market_type = market_type;
    ctx.accounts.market.market_type_discriminator = market_type_discriminator;
    ctx.accounts.market.market_type_value = market_type_value;
    ctx.accounts.market.version = version;
    ctx.accounts.market.market_outcomes_count = 0_u16;
    ctx.accounts.market.market_winning_outcome_index = None;
    ctx.accounts.market.market_lock_timestamp = market_lock_timestamp;
    ctx.accounts.market.market_settle_timestamp = None;
    ctx.accounts.market.title = title;
    ctx.accounts.market.mint_account = ctx.accounts.mint.key();
    ctx.accounts.market.decimal_limit = decimal_limit;
    ctx.accounts.market.escrow_account_bump = ctx.bumps.escrow;
    ctx.accounts.market.funding_account_bump = ctx.bumps.funding;
    ctx.accounts.market.market_status = MarketStatus::Initializing;
    ctx.accounts.market.published = false;
    ctx.accounts.market.suspended = false;
    ctx.accounts.market.event_start_timestamp = event_start_timestamp;
    ctx.accounts.market.market_lock_order_behaviour = market_lock_order_behaviour;

    Ok(())
}

pub fn initialize_outcome(ctx: Context<InitializeMarketOutcome>, title: String) -> Result<()> {
    require!(
        ctx.accounts.market.market_status == MarketStatus::Initializing,
        CoreError::MarketOutcomeMarketInvalidStatus
    );
    require!(
        title.len() <= MarketOutcome::TITLE_MAX_LENGTH,
        CoreError::MarketOutcomeTitleTooLong
    );
    require!(
        ctx.accounts.market.market_outcomes_count < 2,
        CoreError::MarketOutcomeInitError
    );

    ctx.accounts.outcome.market = ctx.accounts.market.key();
    ctx.accounts.outcome.index = ctx.accounts.market.market_outcomes_count;
    ctx.accounts.outcome.title = title;
    ctx.accounts.outcome.price_ladder = vec![];

    ctx.accounts.outcome.prices = ctx
        .accounts
        .price_ladder
        .as_ref()
        .map(|price_ladder| price_ladder.key());

    ctx.accounts
        .market
        .increment_market_outcomes_count()
        .map_err(|_| CoreError::MarketOutcomeInitError)?;
    ctx.accounts
        .market
        .increment_unclosed_accounts_count()
        .map_err(|_| CoreError::MarketOutcomeInitError)?;

    Ok(())
}

fn validate_prices(prices: &[u128]) -> Result<()> {
    let prices_iter = prices.iter();
    for price in prices_iter {
        price_precision_is_within_range(*price)?;
        require!(
            *price > 0 && *price < PRICE_WAD,
            CoreError::MarketPriceOneOrLess
        );
    }
    Ok(())
}

pub fn initialize_market_matching_pool(
    matching_pool: &mut Account<MarketMatchingPool>,
    market: &Account<Market>,
    order: &Order,
) -> Result<()> {
    matching_pool.market = market.key();
    matching_pool.market_outcome_index = order.market_outcome_index;
    matching_pool.price = order.expected_price;
    matching_pool.for_outcome = order.for_outcome;
    matching_pool.payer = order.payer;
    matching_pool.liquidity_amount = 0_u64;
    matching_pool.matched_amount = 0_u64;
    matching_pool.orders = Cirque::new(MarketMatchingPool::QUEUE_LENGTH);
    Ok(())
}

pub fn add_prices_to_market_outcome(
    market_outcome: &mut MarketOutcome,
    new_prices: Vec<u128>,
) -> Result<()> {
    validate_prices(&new_prices)?;

    let mut ladder = market_outcome.price_ladder.clone();

    ladder.extend(new_prices);
    ladder.sort_unstable();
    ladder.dedup();

    market_outcome.price_ladder = ladder;

    require!(
        market_outcome.price_ladder.len() < MarketOutcome::PRICE_LADDER_LENGTH,
        CoreError::MarketPriceListIsFull
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::instructions::market::create_market::{
        add_prices_to_market_outcome, validate_prices,
    };
    use crate::instructions::{PRICE_TICK, PRICE_WAD};
    use crate::state::market_outcome_account::MarketOutcome;

    #[test]
    fn test_add_prices_to_market_outcome() {
        let new_prices = vec![
            110 * PRICE_TICK,
            120 * PRICE_TICK,
            130 * PRICE_TICK,
            400 * PRICE_TICK,
        ];
        let existing_prices = vec![
            200 * PRICE_TICK,
            300 * PRICE_TICK,
            400 * PRICE_TICK,
            400 * PRICE_TICK,
        ];

        let mut outcome = MarketOutcome {
            market: Default::default(),
            index: 0_u16,
            title: "".to_string(),
            prices: Default::default(),
            price_ladder: existing_prices,
        };

        let result = add_prices_to_market_outcome(&mut outcome, new_prices);
        assert!(result.is_ok());
        assert_eq!(outcome.price_ladder.len(), 6);
        assert_eq!(
            outcome.price_ladder,
            vec![
                110 * PRICE_TICK,
                120 * PRICE_TICK,
                130 * PRICE_TICK,
                200 * PRICE_TICK,
                300 * PRICE_TICK,
                400 * PRICE_TICK
            ]
        );
    }

    #[test]
    fn test_validate_prices() {
        let precision_ok =
            validate_prices(&vec![111 * PRICE_TICK, 110 * PRICE_TICK, 100 * PRICE_TICK]);
        assert!(precision_ok.is_ok());

        let precision_not_ok_0 = validate_prices(&vec![
            PRICE_TICK + 1,
            111 * PRICE_TICK,
            110 * PRICE_TICK,
            100 * PRICE_TICK,
        ]);
        assert!(precision_not_ok_0.is_err());

        let precision_not_ok_1 = validate_prices(&vec![
            111 * PRICE_TICK,
            PRICE_TICK + 1,
            110 * PRICE_TICK,
            100 * PRICE_TICK,
        ]);
        assert!(precision_not_ok_1.is_err());

        let precision_not_ok_2 = validate_prices(&vec![
            111 * PRICE_TICK,
            110 * PRICE_TICK,
            PRICE_TICK + 1,
            100 * PRICE_TICK,
        ]);
        assert!(precision_not_ok_2.is_err());

        let precision_not_ok_3 = validate_prices(&vec![
            111 * PRICE_TICK,
            110 * PRICE_TICK,
            100 * PRICE_TICK,
            PRICE_WAD,
            PRICE_TICK + 1,
        ]);
        assert!(precision_not_ok_3.is_err());

        let attempting_to_round_not_ok = validate_prices(&vec![111 * PRICE_TICK + 1]);
        assert!(attempting_to_round_not_ok.is_err());

        let attempting_to_round_2_not_ok = validate_prices(&vec![999 * PRICE_TICK + 1]);
        assert!(attempting_to_round_2_not_ok.is_err());

        let one_not_ok = validate_prices(&vec![PRICE_WAD]);
        assert!(one_not_ok.is_err());

        let fraction_not_ok = validate_prices(&vec![PRICE_WAD + PRICE_TICK]);
        assert!(fraction_not_ok.is_err());

        let zero_not_ok = validate_prices(&vec![0]);
        assert!(zero_not_ok.is_err());
    }
}
