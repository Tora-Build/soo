use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use sooth_account_offsets::{
    PROTOCOL_CONFIG_FEE_BPS_OFFSET, PROTOCOL_CONFIG_TOTAL_LEN as PROTOCOL_CONFIG_MIN_LEN,
};

use crate::error::CoreError;
use crate::instructions::transfer;
use crate::state::market_account::Market;

/// USDC base units have 6 decimals; WAD has 18.
pub const WAD_TO_USDC_SCALAR: u128 = 1_000_000_000_000;

pub fn route_fill_fee<'info>(
    market: &mut Account<'info, Market>,
    market_escrow: &Account<'info, TokenAccount>,
    fee_pool_vault: &Account<'info, TokenAccount>,
    protocol_config: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    stake_matched: u64,
) -> Result<()> {
    let fee_bps = read_fee_bps(protocol_config)?;
    let fill_value_wad = stake_to_wad(stake_matched)?;
    let fee_wad = calculate_fee_wad(fill_value_wad, fee_bps)?;

    record_fee(market, fill_value_wad, fee_bps)?;

    let fee_usdc = wad_to_usdc_ceil(fee_wad)?;
    if fee_usdc > 0 {
        transfer::transfer_from_market_escrow(
            market_escrow,
            fee_pool_vault,
            token_program,
            market,
            fee_usdc,
        )?;
    }

    Ok(())
}

pub fn record_fee(market: &mut Market, fill_value_wad: u128, fee_bps: u16) -> Result<()> {
    let fee_wad = calculate_fee_wad(fill_value_wad, fee_bps)?;
    market.fee_b_base_wad = market
        .fee_b_base_wad
        .checked_add(fee_wad)
        .ok_or(CoreError::ArithmeticError)?;
    Ok(())
}

pub fn stake_to_wad(stake: u64) -> Result<u128> {
    (stake as u128)
        .checked_mul(WAD_TO_USDC_SCALAR)
        .ok_or(error!(CoreError::ArithmeticError))
}

pub fn calculate_fee_wad(fill_value_wad: u128, fee_bps: u16) -> Result<u128> {
    fill_value_wad
        .checked_mul(fee_bps as u128)
        .map(|v| v / 10_000)
        .ok_or(error!(CoreError::ArithmeticError))
}

pub fn wad_to_usdc_ceil(wad: u128) -> Result<u64> {
    if wad == 0 {
        return Ok(0);
    }
    let units = wad
        .checked_add(WAD_TO_USDC_SCALAR - 1)
        .ok_or(error!(CoreError::ArithmeticError))?
        / WAD_TO_USDC_SCALAR;
    u64::try_from(units).map_err(|_| error!(CoreError::ArithmeticError))
}

fn read_fee_bps(protocol_config: &AccountInfo) -> Result<u16> {
    let data = protocol_config.try_borrow_data()?;
    require!(
        data.len() >= PROTOCOL_CONFIG_MIN_LEN,
        CoreError::ArithmeticError
    );
    Ok(u16::from_le_bytes(
        data[PROTOCOL_CONFIG_FEE_BPS_OFFSET..PROTOCOL_CONFIG_FEE_BPS_OFFSET + 2]
            .try_into()
            .map_err(|_| error!(CoreError::ArithmeticError))?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::market_account::{mock_market, MarketStatus};

    #[test]
    fn record_fee_increments_accumulator() {
        let mut market = mock_market(MarketStatus::Open);
        let fill_value_wad = stake_to_wad(1_000_000).unwrap();

        record_fee(&mut market, fill_value_wad, 100).unwrap();

        assert_eq!(market.fee_b_base_wad, 10_000_000_000_000_000);
    }

    #[test]
    fn wad_to_usdc_ceil_rounds_protocol_dust_up() {
        assert_eq!(wad_to_usdc_ceil(0).unwrap(), 0);
        assert_eq!(wad_to_usdc_ceil(1).unwrap(), 1);
        assert_eq!(wad_to_usdc_ceil(WAD_TO_USDC_SCALAR).unwrap(), 1);
        assert_eq!(wad_to_usdc_ceil(WAD_TO_USDC_SCALAR + 1).unwrap(), 2);
    }
}
