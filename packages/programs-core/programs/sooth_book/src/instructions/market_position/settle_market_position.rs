use crate::instructions::transfer;
use crate::state::market_account::MarketStatus::ReadyForSettlement;
use crate::SettleMarketPosition;
use anchor_lang::prelude::*;
use solana_program::log;
use std::convert::TryFrom;

use crate::error::CoreError;

pub fn settle_market_position(ctx: Context<SettleMarketPosition>) -> Result<()> {
    let market_account = &mut ctx.accounts.market;
    require!(
        ReadyForSettlement.eq(&market_account.market_status),
        CoreError::SettlementMarketNotReadyForSettlement
    );

    let market_position = &mut ctx.accounts.market_position;
    if market_position.paid {
        log::sol_log("market position has already been paid out");
        return Ok(());
    }

    let position_profit = market_position.market_outcome_sums
        [market_account.market_winning_outcome_index.unwrap() as usize];
    let total_exposure = market_position.total_exposure();
    let total_payout = position_profit
        .checked_add(i128::from(total_exposure))
        .ok_or(CoreError::SettlementPaymentCalculation)?;
    let total_payout_u64 =
        u64::try_from(total_payout).map_err(|_| CoreError::SettlementPaymentCalculation)?;

    market_position.paid = true;
    market_account.decrement_unsettled_accounts_count()?;

    transfer::transfer_market_position(&ctx, total_payout_u64)
}
