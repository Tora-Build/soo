use anchor_lang::prelude::*;

use sooth_account_offsets::{
    PROTOCOL_CONFIG_FEE_BPS_OFFSET, PROTOCOL_CONFIG_TOTAL_LEN as PROTOCOL_CONFIG_MIN_LEN,
};

use crate::error::SoothMarketError;
use crate::state::{Market, OrderbookPosition};

pub const NUM_TICKS: u16 = 1_000;
pub const BASE_UNIT_WAD: u128 = 1_000_000_000_000;
pub const BPS_DENOMINATOR: u128 = 10_000;

pub fn base_to_wad(base_units: u64) -> Result<u128> {
    (base_units as u128)
        .checked_mul(BASE_UNIT_WAD)
        .ok_or(error!(SoothMarketError::MathOverflow))
}

pub fn wad_to_base(wad: u128) -> Result<u64> {
    (wad / BASE_UNIT_WAD)
        .try_into()
        .map_err(|_| error!(SoothMarketError::MathOverflow))
}

pub fn tick_cost_wad(tick: u16, shares: u128) -> Result<u128> {
    require!(tick <= NUM_TICKS, SoothMarketError::InvalidTick);
    shares
        .checked_mul(tick as u128)
        .ok_or(error!(SoothMarketError::MathOverflow))?
        .checked_div(NUM_TICKS as u128)
        .ok_or(error!(SoothMarketError::MathOverflow))
}

pub fn complement_tick_cost_wad(tick: u16, shares: u128) -> Result<u128> {
    require!(tick <= NUM_TICKS, SoothMarketError::InvalidTick);
    shares
        .checked_mul((NUM_TICKS - tick) as u128)
        .ok_or(error!(SoothMarketError::MathOverflow))?
        .checked_div(NUM_TICKS as u128)
        .ok_or(error!(SoothMarketError::MathOverflow))
}

pub fn read_fee_bps(protocol_config: &AccountInfo) -> Result<u16> {
    let data = protocol_config.try_borrow_data()?;
    require!(
        data.len() >= PROTOCOL_CONFIG_MIN_LEN,
        SoothMarketError::MathOverflow
    );
    Ok(u16::from_le_bytes(
        data[PROTOCOL_CONFIG_FEE_BPS_OFFSET..PROTOCOL_CONFIG_FEE_BPS_OFFSET + 2]
            .try_into()
            .map_err(|_| error!(SoothMarketError::MathOverflow))?,
    ))
}

pub fn compute_taker_pull(base_cost_wad: u128, fee_bps: u16) -> Result<(u64, u64, u64)> {
    let fee_wad = base_cost_wad
        .checked_mul(fee_bps as u128)
        .ok_or(error!(SoothMarketError::MathOverflow))?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(error!(SoothMarketError::MathOverflow))?;
    let taker_base_cost = wad_to_base(base_cost_wad)?;
    let cost_plus_fee_wad = base_cost_wad
        .checked_add(fee_wad)
        .ok_or(error!(SoothMarketError::MathOverflow))?;
    let taker_cost_plus_fee = wad_to_base(cost_plus_fee_wad)?;
    require!(
        taker_cost_plus_fee > 0,
        SoothMarketError::AmountTooSmallForBaseTokenDecimals
    );
    let fee_base = taker_cost_plus_fee
        .checked_sub(taker_base_cost)
        .ok_or(error!(SoothMarketError::MathOverflow))?;
    Ok((taker_base_cost, fee_base, taker_cost_plus_fee))
}

pub fn require_before_deadline(market: &Market) -> Result<()> {
    require_before_deadline_at(market, Clock::get()?.unix_timestamp)
}

pub fn require_before_deadline_at(market: &Market, now: i64) -> Result<()> {
    require!(market.is_open(), SoothMarketError::MarketNotOpen);
    require!(now < market.deadline, SoothMarketError::TradingClosed);
    Ok(())
}

pub fn ensure_position_identity(
    position: &mut OrderbookPosition,
    market: Pubkey,
    user: Pubkey,
) -> Result<()> {
    if position.market == Pubkey::default() {
        position.market = market;
        position.user = user;
        return Ok(());
    }
    require_keys_eq!(
        position.market,
        market,
        SoothMarketError::VaultAuthorityMismatch
    );
    require_keys_eq!(
        position.user,
        user,
        SoothMarketError::VaultAuthorityMismatch
    );
    Ok(())
}

pub fn credit_shares(position: &mut OrderbookPosition, outcome: u8, amount: u128) -> Result<()> {
    match outcome {
        1 => {
            position.yes_shares = position
                .yes_shares
                .checked_add(amount)
                .ok_or(error!(SoothMarketError::MathOverflow))?;
        }
        0 => {
            position.no_shares = position
                .no_shares
                .checked_add(amount)
                .ok_or(error!(SoothMarketError::MathOverflow))?;
        }
        _ => return Err(error!(SoothMarketError::InvalidOutcome)),
    }
    Ok(())
}

pub fn debit_shares(position: &mut OrderbookPosition, outcome: u8, amount: u128) -> Result<()> {
    match outcome {
        1 => {
            require!(
                position.yes_shares >= amount,
                SoothMarketError::InsufficientOutcomeShares
            );
            position.yes_shares = position
                .yes_shares
                .checked_sub(amount)
                .ok_or(error!(SoothMarketError::MathOverflow))?;
        }
        0 => {
            require!(
                position.no_shares >= amount,
                SoothMarketError::InsufficientOutcomeShares
            );
            position.no_shares = position
                .no_shares
                .checked_sub(amount)
                .ok_or(error!(SoothMarketError::MathOverflow))?;
        }
        _ => return Err(error!(SoothMarketError::InvalidOutcome)),
    }
    Ok(())
}
