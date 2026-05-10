use crate::instructions::PRICE_TICK;
use crate::state::type_size::{vec_size, DISCRIMINATOR_SIZE, PUB_KEY_SIZE, U128_SIZE, U16_SIZE};
use anchor_lang::prelude::*;

// Non-terminal probability ticks: 0.001 WAD through 0.999 WAD.
pub const DEFAULT_PRICE_COUNT: usize = 999;

pub const DEFAULT_PRICES: [u128; DEFAULT_PRICE_COUNT] = default_prices();

const fn default_prices() -> [u128; DEFAULT_PRICE_COUNT] {
    let mut prices = [0_u128; DEFAULT_PRICE_COUNT];
    let mut index = 0;
    while index < DEFAULT_PRICE_COUNT {
        prices[index] = (index as u128 + 1) * PRICE_TICK;
        index += 1;
    }
    prices
}

#[account]
#[derive(Debug)]
pub struct PriceLadder {
    pub authority: Pubkey,
    pub max_number_of_prices: u16,
    pub prices: Vec<u128>,
}

impl PriceLadder {
    pub fn size_for(number_of_prices: u16) -> usize {
        DISCRIMINATOR_SIZE
            + PUB_KEY_SIZE
            + U16_SIZE
            + vec_size(U128_SIZE, number_of_prices as usize)
    }
}
