//! Orderbook helpers shared by the CLOB instructions.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::math::{NUM_TICKS, BASE_UNIT_WAD};
use crate::state::{Market, OrderbookPosition, ProtocolConfig};

pub const BPS_DENOMINATOR: u128 = 10_000;

pub fn base_to_wad(base_units: u64) -> Result<u128> {
    (base_units as u128)
        .checked_mul(BASE_UNIT_WAD)
        .ok_or(error!(SoothCoreError::MathOverflow))
}

pub fn wad_to_base(wad: u128) -> Result<u64> {
    (wad / BASE_UNIT_WAD)
        .try_into()
        .map_err(|_| error!(SoothCoreError::MathOverflow))
}

pub fn tick_cost_wad(tick: u16, shares: u128) -> Result<u128> {
    require!(tick <= NUM_TICKS, SoothCoreError::InvalidTick);
    shares
        .checked_mul(tick as u128)
        .ok_or(error!(SoothCoreError::MathOverflow))?
        .checked_div(NUM_TICKS as u128)
        .ok_or(error!(SoothCoreError::MathOverflow))
}

pub fn complement_tick_cost_wad(tick: u16, shares: u128) -> Result<u128> {
    require!(tick <= NUM_TICKS, SoothCoreError::InvalidTick);
    shares
        .checked_mul((NUM_TICKS - tick) as u128)
        .ok_or(error!(SoothCoreError::MathOverflow))?
        .checked_div(NUM_TICKS as u128)
        .ok_or(error!(SoothCoreError::MathOverflow))
}

/// Read fee_bps from the typed ProtocolConfig account.
pub fn read_fee_bps(protocol_config: &Account<ProtocolConfig>) -> u16 {
    protocol_config.fee_bps
}

pub fn compute_taker_pull_from_fee_wad(
    base_cost_wad: u128,
    fee_wad: u128,
) -> Result<(u64, u64, u64)> {
    let taker_base_cost = wad_to_base(base_cost_wad)?;
    let cost_plus_fee_wad = base_cost_wad
        .checked_add(fee_wad)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    let taker_cost_plus_fee = wad_to_base(cost_plus_fee_wad)?;
    require!(
        taker_cost_plus_fee > 0,
        SoothCoreError::AmountTooSmallForBaseTokenDecimals
    );
    let fee_base = taker_cost_plus_fee
        .checked_sub(taker_base_cost)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    Ok((taker_base_cost, fee_base, taker_cost_plus_fee))
}

pub fn compute_taker_pull(base_cost_wad: u128, fee_bps: u16) -> Result<(u64, u64, u64)> {
    let fee_wad = base_cost_wad
        .checked_mul(fee_bps as u128)
        .ok_or(error!(SoothCoreError::MathOverflow))?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    compute_taker_pull_from_fee_wad(base_cost_wad, fee_wad)
}

pub fn require_before_deadline(market: &Market) -> Result<()> {
    require_before_deadline_at(market, Clock::get()?.unix_timestamp)
}

pub fn require_before_deadline_at(market: &Market, now: i64) -> Result<()> {
    require!(market.is_open(), SoothCoreError::MarketNotOpen);
    require!(now < market.deadline, SoothCoreError::TradingClosed);
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
        SoothCoreError::VaultAuthorityMismatch
    );
    require_keys_eq!(
        position.user,
        user,
        SoothCoreError::VaultAuthorityMismatch
    );
    Ok(())
}

pub fn credit_shares(position: &mut OrderbookPosition, outcome: u8, amount: u128) -> Result<()> {
    match outcome {
        1 => {
            position.yes_shares = position
                .yes_shares
                .checked_add(amount)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
        }
        0 => {
            position.no_shares = position
                .no_shares
                .checked_add(amount)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
        }
        _ => return Err(error!(SoothCoreError::InvalidOutcome)),
    }
    Ok(())
}

pub fn debit_shares(position: &mut OrderbookPosition, outcome: u8, amount: u128) -> Result<()> {
    match outcome {
        1 => {
            require!(
                position.yes_shares >= amount,
                SoothCoreError::InsufficientOutcomeShares
            );
            position.yes_shares = position
                .yes_shares
                .checked_sub(amount)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
        }
        0 => {
            require!(
                position.no_shares >= amount,
                SoothCoreError::InsufficientOutcomeShares
            );
            position.no_shares = position
                .no_shares
                .checked_sub(amount)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
        }
        _ => return Err(error!(SoothCoreError::InvalidOutcome)),
    }
    Ok(())
}
