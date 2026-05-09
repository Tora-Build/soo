use crate::error::CoreError;
use crate::state::type_size::*;
use anchor_lang::prelude::*;
use std::cmp::Ordering;

#[account]
pub struct MarketLiquidities {
    pub market: Pubkey,
    pub stake_matched_total: u64,
    pub liquidities_for: Vec<MarketOutcomePriceLiquidity>,
    pub liquidities_against: Vec<MarketOutcomePriceLiquidity>,
}

impl MarketLiquidities {
    // Lifted from Monaco's 30 to 1000 for Sooth: prediction-market grids
    // populate every tick at depth, where sportsbooks rarely exceed
    // ~30 distinct active levels per side. CU bound for matching against
    // a populated 1000-entry book is ~150-210k (see docs/sooth_book/cu-analysis.md),
    // well under the 1.4M per-tx budget. Account size becomes ~200KB
    // per MarketLiquidities (vs ~6KB at 30), comfortably under Solana's
    // 10MB account ceiling.
    const LIQUIDITIES_VEC_LENGTH: usize = 1000_usize;
    pub const SIZE: usize = DISCRIMINATOR_SIZE
        + PUB_KEY_SIZE // market
        + U64_SIZE // stake_matched_total
        + vec_size(MarketOutcomePriceLiquidity::SIZE, MarketLiquidities::LIQUIDITIES_VEC_LENGTH) // for
        + vec_size(MarketOutcomePriceLiquidity::SIZE, MarketLiquidities::LIQUIDITIES_VEC_LENGTH); // against

    pub fn get_liquidity_for(
        &self,
        outcome: u16,
        price: f64,
    ) -> Option<&MarketOutcomePriceLiquidity> {
        self.liquidities_for
            .binary_search_by(Self::sorter_for(outcome, price))
            .ok()
            .map(|index| &self.liquidities_for[index])
    }

    pub fn get_liquidity_against(
        &self,
        outcome: u16,
        price: f64,
    ) -> Option<&MarketOutcomePriceLiquidity> {
        self.liquidities_against
            .binary_search_by(Self::sorter_against(outcome, price))
            .ok()
            .map(|index| &self.liquidities_against[index])
    }

    pub fn add_liquidity_for(&mut self, outcome: u16, price: f64, liquidity: u64) -> Result<()> {
        let is_full = self.is_full();
        Self::add_liquidity(
            &mut self.liquidities_for,
            Self::sorter_for(outcome, price),
            outcome,
            price,
            liquidity,
            is_full,
        )
    }

    pub fn add_liquidity_against(
        &mut self,
        outcome: u16,
        price: f64,
        liquidity: u64,
    ) -> Result<()> {
        let is_full = self.is_full();
        Self::add_liquidity(
            &mut self.liquidities_against,
            Self::sorter_against(outcome, price),
            outcome,
            price,
            liquidity,
            is_full,
        )
    }

    fn add_liquidity(
        liquidities: &mut Vec<MarketOutcomePriceLiquidity>,
        search_function: impl FnMut(&MarketOutcomePriceLiquidity) -> Ordering,
        outcome: u16,
        price: f64,
        liquidity: u64,
        is_full: bool,
    ) -> Result<()> {
        match liquidities.binary_search_by(search_function) {
            Ok(index) => {
                let value = &mut liquidities[index];
                value.liquidity = value
                    .liquidity
                    .checked_add(liquidity)
                    .ok_or(CoreError::MarketLiquiditiesUpdateError)?
            }
            Err(index) => {
                if is_full {
                    return Err(error!(CoreError::MarketLiquiditiesIsFull));
                }
                liquidities.insert(
                    index,
                    MarketOutcomePriceLiquidity {
                        outcome,
                        price,
                        liquidity,
                    },
                )
            }
        }

        Ok(())
    }

    pub fn remove_liquidity_for(
        &mut self,
        outcome: u16,
        price: f64,
        liquidity: u64,
    ) -> Result<u64> {
        Self::remove_liquidity(
            &mut self.liquidities_for,
            Self::sorter_for(outcome, price),
            liquidity,
        )
    }

    pub fn remove_liquidity_against(
        &mut self,
        outcome: u16,
        price: f64,
        liquidity: u64,
    ) -> Result<u64> {
        Self::remove_liquidity(
            &mut self.liquidities_against,
            Self::sorter_against(outcome, price),
            liquidity,
        )
    }

    fn remove_liquidity(
        liquidities: &mut Vec<MarketOutcomePriceLiquidity>,
        search_function: impl FnMut(&MarketOutcomePriceLiquidity) -> Ordering,
        liquidity: u64,
    ) -> Result<u64> {
        match liquidities.binary_search_by(search_function) {
            Ok(index) => {
                let value = &mut liquidities[index];
                let liquidity_removed = liquidity.min(value.liquidity);
                value.liquidity = value
                    .liquidity
                    .checked_sub(liquidity_removed)
                    .ok_or(CoreError::MarketLiquiditiesUpdateError)?;
                if value.liquidity == 0 {
                    liquidities.remove(index);
                }
                Ok(liquidity_removed)
            }
            Err(_) => Err(error!(CoreError::MarketLiquiditiesUpdateError)),
        }
    }

    fn sorter_for(
        outcome: u16,
        price: f64,
    ) -> impl FnMut(&MarketOutcomePriceLiquidity) -> Ordering {
        move |liquidity| {
            #[allow(clippy::comparison_chain)]
            if outcome < liquidity.outcome {
                return Ordering::Greater;
            } else if liquidity.outcome < outcome {
                return Ordering::Less;
            }

            if price < liquidity.price {
                return Ordering::Greater;
            } else if liquidity.price < price {
                return Ordering::Less;
            }

            Ordering::Equal
        }
    }

    fn sorter_against(
        outcome: u16,
        price: f64,
    ) -> impl FnMut(&MarketOutcomePriceLiquidity) -> Ordering {
        move |liquidity| {
            #[allow(clippy::comparison_chain)]
            if outcome < liquidity.outcome {
                return Ordering::Less;
            } else if liquidity.outcome < outcome {
                return Ordering::Greater;
            }

            if price < liquidity.price {
                return Ordering::Less;
            } else if liquidity.price < price {
                return Ordering::Greater;
            }

            Ordering::Equal
        }
    }

    fn is_full(&self) -> bool {
        Self::LIQUIDITIES_VEC_LENGTH + Self::LIQUIDITIES_VEC_LENGTH
            <= self.liquidities_for.len() + self.liquidities_against.len()
    }

    pub fn update_stake_matched_total(&mut self, stake_matched: u64) -> Result<()> {
        if stake_matched > 0_u64 {
            self.stake_matched_total = self
                .stake_matched_total
                .checked_add(stake_matched)
                .ok_or(CoreError::MarketLiquiditiesUpdateError)?;
        }
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq)]
pub struct MarketOutcomePriceLiquidity {
    pub outcome: u16,
    pub price: f64,
    pub liquidity: u64,
}

impl MarketOutcomePriceLiquidity {
    pub const SIZE: usize = U16_SIZE // outcome
        + F64_SIZE // price
        + U64_SIZE; // liquidity
}

#[cfg(test)]
pub fn mock_market_liquidities(market_pk: Pubkey) -> MarketLiquidities {
    MarketLiquidities {
        market: market_pk,
        liquidities_for: Vec::new(),
        liquidities_against: Vec::new(),
        stake_matched_total: 0_u64,
    }
}

#[cfg(test)]
pub fn mock_liquidity(outcome: u16, price: f64, liquidity: u64) -> MarketOutcomePriceLiquidity {
    MarketOutcomePriceLiquidity {
        outcome,
        price,
        liquidity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_liquidity() {
        let mut mls = mock_market_liquidities(Pubkey::default());

        mls.add_liquidity_for(0, 2.8, 5_000).unwrap();
        mls.add_liquidity_for(0, 2.8, 5_000).unwrap();
        mls.add_liquidity_for(0, 2.9, 15_000).unwrap();
        mls.add_liquidity_for(1, 2.8, 20_000).unwrap();
        mls.add_liquidity_for(2, 2.8, 25_000).unwrap();
        mls.add_liquidity_for(2, 3.5, 30_000).unwrap();

        assert_eq!(
            vec![
                mock_liquidity(0, 2.8, 10_000),
                mock_liquidity(0, 2.9, 15_000),
                mock_liquidity(1, 2.8, 20_000),
                mock_liquidity(2, 2.8, 25_000),
                mock_liquidity(2, 3.5, 30_000),
            ],
            mls.liquidities_for
        );

        mls.add_liquidity_against(0, 2.8, 5_000).unwrap();
        mls.add_liquidity_against(0, 2.8, 5_000).unwrap();
        mls.add_liquidity_against(0, 2.9, 15_000).unwrap();
        mls.add_liquidity_against(1, 2.8, 20_000).unwrap();
        mls.add_liquidity_against(2, 2.8, 25_000).unwrap();
        mls.add_liquidity_against(2, 3.5, 30_000).unwrap();

        assert_eq!(
            vec![
                mock_liquidity(2, 3.5, 30_000),
                mock_liquidity(2, 2.8, 25_000),
                mock_liquidity(1, 2.8, 20_000),
                mock_liquidity(0, 2.9, 15_000),
                mock_liquidity(0, 2.8, 10_000),
            ],
            mls.liquidities_against
        );
    }

    #[test]
    fn test_get_liquidity_for() {
        let mut mls = mock_market_liquidities(Pubkey::default());
        mls.add_liquidity_for(1, 2.8, 10).unwrap();
        mls.add_liquidity_for(1, 3.0, 20).unwrap();

        assert_eq!(
            Some(&mock_liquidity(1, 2.8, 10)),
            mls.get_liquidity_for(1, 2.8)
        );
        assert!(mls.get_liquidity_for(1, 2.9).is_none());
    }

    #[test]
    fn test_get_liquidity_against() {
        let mut mls = mock_market_liquidities(Pubkey::default());
        mls.add_liquidity_against(1, 2.8, 10).unwrap();
        mls.add_liquidity_against(1, 3.0, 20).unwrap();

        assert_eq!(
            Some(&mock_liquidity(1, 3.0, 20)),
            mls.get_liquidity_against(1, 3.0)
        );
        assert!(mls.get_liquidity_against(1, 2.9).is_none());
    }

    #[test]
    fn test_remove_liquidity() {
        let mut mls = mock_market_liquidities(Pubkey::default());
        mls.add_liquidity_for(1, 2.8, 10).unwrap();

        assert_eq!(4, mls.remove_liquidity_for(1, 2.8, 4).unwrap());
        assert_eq!(
            Some(&mock_liquidity(1, 2.8, 6)),
            mls.get_liquidity_for(1, 2.8)
        );
        assert_eq!(6, mls.remove_liquidity_for(1, 2.8, 10).unwrap());
        assert!(mls.get_liquidity_for(1, 2.8).is_none());
    }

    #[test]
    fn test_add_liquidity_when_full() {
        let mut mls = mock_market_liquidities(Pubkey::default());
        for i in 0..MarketLiquidities::LIQUIDITIES_VEC_LENGTH {
            mls.add_liquidity_for(i as u16, 2.0, 10).unwrap();
            mls.add_liquidity_against(i as u16, 2.0, 10).unwrap();
        }

        assert_eq!(
            Err(error!(CoreError::MarketLiquiditiesIsFull)),
            mls.add_liquidity_for(0, 3.0, 10)
        );
        assert!(mls.add_liquidity_for(0, 2.0, 10).is_ok());
    }

    #[test]
    fn test_update_stake_matched_total() {
        let mut mls = mock_market_liquidities(Pubkey::default());

        assert!(mls.update_stake_matched_total(10_u64).is_ok());
        assert_eq!(10_u64, mls.stake_matched_total);
        assert!(mls.update_stake_matched_total(20_u64).is_ok());
        assert_eq!(30_u64, mls.stake_matched_total);
        assert!(mls.update_stake_matched_total(0_u64).is_ok());
        assert_eq!(30_u64, mls.stake_matched_total);
    }
}
