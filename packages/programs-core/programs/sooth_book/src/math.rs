use anchor_lang::prelude::*;

use crate::error::CoreError;

pub const NUM_TICKS: u16 = 1000;
pub const MIN_TICK: u16 = 1;
pub const MAX_TICK: u16 = 999;
pub const BASE_UNIT_WAD: u128 = 1_000_000_000_000;

pub fn min_resting_order_for_tick(tick: u16) -> Result<u128> {
    require!(
        (MIN_TICK..=MAX_TICK).contains(&tick),
        CoreError::InvalidTick
    );
    let numerator = BASE_UNIT_WAD
        .checked_mul(NUM_TICKS as u128)
        .and_then(|v| v.checked_add(tick as u128))
        .and_then(|v| v.checked_sub(1))
        .ok_or(error!(CoreError::MathOverflow))?;
    Ok(numerator / tick as u128)
}

pub fn tick_cost_wad(amount: u128, tick: u16) -> Result<u128> {
    require!(
        (MIN_TICK..=MAX_TICK).contains(&tick),
        CoreError::InvalidTick
    );
    amount
        .checked_mul(tick as u128)
        .and_then(|v| v.checked_div(NUM_TICKS as u128))
        .ok_or(error!(CoreError::MathOverflow))
}

pub fn wad_to_base(wad: u128) -> Result<u64> {
    (wad / BASE_UNIT_WAD)
        .try_into()
        .map_err(|_| error!(CoreError::MathOverflow))
}

pub fn resting_cost_base(amount: u128, tick: u16) -> Result<u64> {
    wad_to_base(tick_cost_wad(amount, tick)?)
}
