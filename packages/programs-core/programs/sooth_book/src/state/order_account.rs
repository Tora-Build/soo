use crate::error::CoreError;
use crate::instructions::calculate_for_payout;
use crate::state::type_size::*;
use anchor_lang::prelude::*;

#[account]
pub struct ReservedOrder {}

impl ReservedOrder {
    pub const SIZE: usize = DISCRIMINATOR_SIZE;
}

#[account]
pub struct Order {
    pub purchaser: Pubkey, // wallet of user/intializer/ordertor who purchased the order
    pub market: Pubkey,    // market on which order was made
    pub market_outcome_index: u16, // market outcome on which order was made
    pub for_outcome: bool, // is order for or against the outcome
    pub order_status: OrderStatus, // status
    pub stake: u64,        // total stake amount provided by purchaser
    pub voided_stake: u64, // stake amount returned to purchaser due to cancelation or settlement for partially matched orders
    pub expected_price: u128, // expected price provided by purchaser
    pub creation_timestamp: i64,
    // matching data
    pub stake_unmatched: u64, // stake amount available for matching
    pub payout: u64,          // amount paid to purchaser during settlement for winning orders
    pub payer: Pubkey,        // solana account fee payer
}

impl Order {
    pub const SIZE: usize = DISCRIMINATOR_SIZE
        + (PUB_KEY_SIZE * 2) // purchaser, market
        + U16_SIZE // market_outcome_index
        + BOOL_SIZE // for outcome
        + ENUM_SIZE // order_status
        + (U64_SIZE * 4) // stake, payout, stake_unmatched, voided_stake
        + U128_SIZE // expected_price
        + I64_SIZE // creation_timestamp
        + PUB_KEY_SIZE; // payer

    pub fn is_completed(&self) -> bool {
        self.order_status == OrderStatus::SettledWin
            || self.order_status == OrderStatus::SettledLose
            || self.order_status == OrderStatus::Cancelled
            || self.order_status == OrderStatus::Voided
    }

    pub fn match_stake_unmatched(&mut self, stake_matched: u64, price_matched: u128) -> Result<()> {
        self.stake_unmatched = self
            .stake_unmatched
            .checked_sub(stake_matched)
            .ok_or(CoreError::ArithmeticError)?;
        self.payout = self
            .payout
            .checked_add(calculate_for_payout(stake_matched, price_matched))
            .ok_or(CoreError::ArithmeticError)?;
        self.order_status = OrderStatus::Matched;
        Ok(())
    }

    pub fn void_stake_unmatched(&mut self) -> Result<()> {
        self.void_stake_unmatched_by(self.stake_unmatched)
    }

    pub fn void_stake_unmatched_by(&mut self, stake_to_void: u64) -> Result<()> {
        self.voided_stake = self
            .voided_stake
            .checked_add(stake_to_void)
            .ok_or(CoreError::ArithmeticError)?;
        self.stake_unmatched = self
            .stake_unmatched
            .checked_sub(stake_to_void)
            .ok_or(CoreError::ArithmeticError)?;

        if self.stake == self.voided_stake && self.order_status == OrderStatus::Open {
            self.order_status = OrderStatus::Cancelled;
        }

        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Debug, Clone, PartialEq, Eq)]
pub enum OrderStatus {
    Open,        // waiting on liquidity to match
    Matched,     // liquidity available, order has been match
    SettledWin,  // order won and has been paid out
    SettledLose, // order lost, nothing to pay out
    Cancelled,   // order cancelled
    Voided,      // order voided
}

#[cfg(test)]
use crate::state::market_order_request_queue::OrderRequest;

#[cfg(test)]
pub fn mock_order_default() -> Order {
    mock_order(Pubkey::new_unique(), 0, true, 0, 0, Pubkey::new_unique())
}

#[cfg(test)]
pub fn mock_order_from_order_request(
    market: Pubkey,
    order_request: OrderRequest,
    payer: Pubkey,
) -> Order {
    Order {
        market,
        purchaser: order_request.purchaser,
        market_outcome_index: order_request.market_outcome_index,
        for_outcome: order_request.for_outcome,
        stake: order_request.stake,
        expected_price: order_request.expected_price,
        stake_unmatched: order_request.stake,
        voided_stake: 0_u64,
        payout: 0_u64,
        order_status: OrderStatus::Open,
        creation_timestamp: 0,
        payer,
    }
}

#[cfg(test)]
pub fn mock_order(
    market: Pubkey,
    market_outcome_index: u16,
    for_outcome: bool,
    expected_price: u128,
    stake: u64,
    payer: Pubkey,
) -> Order {
    Order {
        purchaser: Pubkey::new_unique(),
        market,
        market_outcome_index,
        for_outcome,
        order_status: OrderStatus::Open,
        stake,
        voided_stake: 0,
        expected_price,
        creation_timestamp: 0,
        stake_unmatched: stake,
        payout: 0,
        payer,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::order_account::OrderStatus;
    use anchor_lang::prelude::Pubkey;

    #[test]
    fn test_match_order_no_match() {
        // given
        let mut order = mock_order(
            Pubkey::new_unique(),
            1,
            true,
            476 * crate::instructions::PRICE_TICK,
            1000,
            Pubkey::new_unique(),
        );

        // when
        let result = order.match_stake_unmatched(1001, 476 * crate::instructions::PRICE_TICK);

        // then
        assert!(result.is_err());
        assert_eq!(order.order_status, OrderStatus::Open);
        assert_eq!(order.stake_unmatched, 1000);
        assert_eq!(order.payout, 0);
    }

    #[test]
    fn test_match_order_partial_match() {
        // given
        let mut order = mock_order(
            Pubkey::new_unique(),
            1,
            true,
            476 * crate::instructions::PRICE_TICK,
            1000,
            Pubkey::new_unique(),
        );
        let stake_matched = order.stake_unmatched - 10;

        // when
        let result =
            order.match_stake_unmatched(stake_matched, 476 * crate::instructions::PRICE_TICK);

        // then
        assert!(result.is_ok());
        assert_eq!(order.order_status, OrderStatus::Matched);
        assert_eq!(order.stake_unmatched, 10);
        assert_eq!(order.payout, 990);
    }

    #[test]
    fn test_match_order_full_match() {
        // when
        let mut order = mock_order(
            Pubkey::new_unique(),
            1,
            true,
            476 * crate::instructions::PRICE_TICK,
            1000,
            Pubkey::new_unique(),
        );
        let stake_matched = order.stake_unmatched;

        // when
        let result =
            order.match_stake_unmatched(stake_matched, 476 * crate::instructions::PRICE_TICK);

        // then
        assert!(result.is_ok());
        assert_eq!(order.order_status, OrderStatus::Matched);
        assert_eq!(order.stake_unmatched, 0);
        assert_eq!(order.payout, 1000);
    }

    #[test]
    fn test_void_stake_unmatched() {
        // when
        let mut order = mock_order(
            Pubkey::new_unique(),
            1,
            true,
            476 * crate::instructions::PRICE_TICK,
            1000,
            Pubkey::new_unique(),
        );
        let _ = order.void_stake_unmatched();

        // then
        assert_eq!(order.order_status, OrderStatus::Cancelled);
        assert_eq!(order.stake_unmatched, 0);
        assert_eq!(order.voided_stake, 1000);
    }

    #[test]
    fn test_void_stake_unmatched_after_partial() {
        // when
        let mut order = mock_order(
            Pubkey::new_unique(),
            1,
            true,
            476 * crate::instructions::PRICE_TICK,
            1000,
            Pubkey::new_unique(),
        );
        let _ = order.void_stake_unmatched_by(200);
        let _ = order.void_stake_unmatched();

        // then
        assert_eq!(order.order_status, OrderStatus::Cancelled);
        assert_eq!(order.stake_unmatched, 0);
        assert_eq!(order.voided_stake, 1000);
    }
}
