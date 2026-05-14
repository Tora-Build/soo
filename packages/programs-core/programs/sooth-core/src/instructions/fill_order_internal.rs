//! `fill_order_internal` — direct (non-CPI) fill handler for the CLOB.
//!
//! Adapted from `sooth_market::fill_order`. Parent-ix introspection removed.
//! `set_return_data` removed. Returns `(fee_base_delta, taker_payout_delta)`
//! as a plain tuple directly to the caller.
//!
//! `protocol_config` is now a typed `Account<'info, ProtocolConfig>`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::SoothCoreError;
use crate::instructions::orderbook_common::{
    complement_tick_cost_wad, compute_taker_pull, credit_shares,
    read_fee_bps, tick_cost_wad, wad_to_base,
};
use crate::math::NUM_TICKS;
use crate::state::{Market, OrderbookPosition, ProtocolConfig};

#[allow(clippy::too_many_arguments)]
pub fn fill_order_internal<'info>(
    market: &Account<'info, Market>,
    vault_authority: &UncheckedAccount<'info>,
    market_usdc_vault: &Account<'info, TokenAccount>,
    taker_usdc_ata: &Account<'info, TokenAccount>,
    maker_usdc_ata: &AccountInfo<'info>,
    taker_orderbook_position: &UncheckedAccount<'info>,
    maker_position_info: &AccountInfo<'info>,
    taker: &Signer<'info>,
    protocol_config: &Account<'info, ProtocolConfig>,
    token_program: &Program<'info, Token>,
    system_program: &Program<'info, System>,
    rent: &Sysvar<'info, Rent>,
    maker: Pubkey,
    taker_side: u8,
    shares: u128,
    taker_tick: u16,
    maker_tick: u16,
    taker_escrow: bool,
    maker_escrow: bool,
) -> Result<(u128, u128)> {
    require_before_deadline(market)?;
    require!(
        taker_side == 0 || taker_side == 1,
        SoothCoreError::InvalidOutcome
    );
    require!(taker_tick <= NUM_TICKS, SoothCoreError::InvalidTick);
    require!(maker_tick <= NUM_TICKS, SoothCoreError::InvalidTick);

    let market_key = market.key();

    // Deserialize the taker orderbook position (init_if_needed logic).
    let taker_position = load_or_init_position(
        taker_orderbook_position.to_account_info(),
        market_key,
        taker.key(),
        system_program,
        rent,
        taker,
    )?;

    // Deserialize the maker orderbook position.
    let maker_position = load_or_init_position(
        maker_position_info.clone(),
        market_key,
        maker,
        system_program,
        rent,
        taker,
    )?;

    let _ = (taker_position, maker_position); // we'll mutate via info below

    let mut fee_base_delta: u128 = 0;
    let mut taker_payout_delta: u128 = 0;

    if !taker_escrow {
        let fee_bps = read_fee_bps(protocol_config);
        let base_cost_wad = tick_cost_wad(taker_tick, shares)?;
        let (_taker_base_cost, fee_base, taker_cost_plus_fee) =
            compute_taker_pull(base_cost_wad, fee_bps)?;

        token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                Transfer {
                    from: taker_usdc_ata.to_account_info(),
                    to: market_usdc_vault.to_account_info(),
                    authority: taker.to_account_info(),
                },
            ),
            taker_cost_plus_fee,
        )?;
        fee_base_delta = fee_base as u128;
    }

    let market_id = market.market_id;
    let vault_authority_bump = market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

    if maker_escrow {
        let maker_payout = wad_to_base(complement_tick_cost_wad(maker_tick, shares)?)?;
        if maker_payout > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    Transfer {
                        from: market_usdc_vault.to_account_info(),
                        to: maker_usdc_ata.clone(),
                        authority: vault_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                maker_payout,
            )?;
        }
    }

    if taker_escrow {
        let taker_payout = wad_to_base(complement_tick_cost_wad(taker_tick, shares)?)?;
        taker_payout_delta = taker_payout_delta
            .checked_add(taker_payout as u128)
            .ok_or(error!(SoothCoreError::MathOverflow))?;
    }

    let tick_sum = (taker_tick as u32)
        .checked_add(maker_tick as u32)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    if tick_sum > NUM_TICKS as u32 {
        let surplus_wad = shares
            .checked_mul((tick_sum - NUM_TICKS as u32) as u128)
            .ok_or(error!(SoothCoreError::MathOverflow))?
            .checked_div(NUM_TICKS as u128)
            .ok_or(error!(SoothCoreError::MathOverflow))?;
        let surplus = wad_to_base(surplus_wad)?;
        taker_payout_delta = taker_payout_delta
            .checked_add(surplus as u128)
            .ok_or(error!(SoothCoreError::MathOverflow))?;
    }

    // Credit shares to maker/taker positions.
    if !maker_escrow {
        mutate_position_shares(maker_position_info, taker_side ^ 1, shares, true)?;
    }
    if !taker_escrow {
        mutate_position_shares(
            &taker_orderbook_position.to_account_info(),
            taker_side,
            shares,
            true,
        )?;
    }

    Ok((fee_base_delta, taker_payout_delta))
}

fn require_before_deadline(market: &Market) -> Result<()> {
    require!(market.is_open(), SoothCoreError::MarketNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(now < market.deadline, SoothCoreError::TradingClosed);
    Ok(())
}

/// Load or lazily init an OrderbookPosition from raw account data.
/// Returns the deserialized position (for validation) but also mutates
/// the account if it is freshly initialized.
fn load_or_init_position<'info>(
    info: AccountInfo<'info>,
    market: Pubkey,
    user: Pubkey,
    system_program: &Program<'info, System>,
    rent: &Sysvar<'info, Rent>,
    payer: &Signer<'info>,
) -> Result<OrderbookPosition> {
    use anchor_lang::system_program;

    if info.data_is_empty() {
        let space = OrderbookPosition::SPACE;
        let lamports = rent.minimum_balance(space);
        system_program::transfer(
            CpiContext::new(
                system_program.to_account_info(),
                system_program::Transfer {
                    from: payer.to_account_info(),
                    to: info.clone(),
                },
            ),
            lamports,
        )?;
        // Write discriminator + zero-init body.
        let mut data = info.try_borrow_mut_data()?;
        use anchor_lang::Discriminator;
        data[..8].copy_from_slice(&OrderbookPosition::DISCRIMINATOR);
        drop(data);

        return Ok(OrderbookPosition {
            market,
            user,
            yes_shares: 0,
            no_shares: 0,
            _reserved: [0u8; 16],
        });
    }

    use anchor_lang::AccountDeserialize;
    let data = info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let pos = OrderbookPosition::try_deserialize(&mut slice)
        .map_err(|_| error!(SoothCoreError::MakerAccountMismatch))?;
    drop(data);
    Ok(pos)
}

/// Apply a credit or debit to an OrderbookPosition stored in raw account data.
fn mutate_position_shares(
    info: &AccountInfo,
    outcome: u8,
    amount: u128,
    credit: bool,
) -> Result<()> {
    use anchor_lang::{AccountDeserialize, AccountSerialize};

    let data = info.try_borrow_mut_data()?;
    let mut slice: &[u8] = &data;
    let mut pos = OrderbookPosition::try_deserialize(&mut slice)
        .map_err(|_| error!(SoothCoreError::MakerAccountMismatch))?;
    drop(data);

    if credit {
        credit_shares(&mut pos, outcome, amount)?;
    } else {
        use crate::instructions::orderbook_common::debit_shares;
        debit_shares(&mut pos, outcome, amount)?;
    }

    let mut data = info.try_borrow_mut_data()?;
    pos.try_serialize(&mut &mut data[..])?;
    Ok(())
}
