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

/// Create and zero-initialize an `OrderbookPosition` PDA that does not exist yet.
///
/// The CLOB paths hold maker/taker positions as raw `AccountInfo` (they arrive via
/// `remaining_accounts`), so Anchor's `init_if_needed` is unavailable and the account
/// must be created by hand. Funding the address is *not* enough: a system account with
/// zero data length cannot be written to, so `allocate` + `assign` (or `create_account`,
/// which does both) is mandatory before serializing.
///
/// Callers must have already verified `info.data_is_empty()`.
pub fn create_orderbook_position<'info>(
    info: &AccountInfo<'info>,
    market: &Account<'info, Market>,
    user: Pubkey,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
    rent: &Rent,
) -> Result<OrderbookPosition> {
    use anchor_lang::system_program;

    let space = OrderbookPosition::SPACE;
    let lamports = rent.minimum_balance(space);

    let (expected, bump) = Pubkey::find_program_address(
        &[
            b"orderbook_position",
            market.market_id.as_ref(),
            user.as_ref(),
        ],
        &crate::ID,
    );
    require_keys_eq!(*info.key, expected, SoothCoreError::MakerAccountMismatch);

    let bump_seed = [bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"orderbook_position",
        market.market_id.as_ref(),
        user.as_ref(),
        bump_seed.as_ref(),
    ]];

    let current = info.lamports();
    if current == 0 {
        system_program::create_account(
            CpiContext::new_with_signer(
                system_program.to_account_info(),
                system_program::CreateAccount {
                    from: payer.to_account_info(),
                    to: info.clone(),
                },
                signer_seeds,
            ),
            lamports,
            space as u64,
            &crate::ID,
        )?;
    } else {
        // The PDA was pre-funded (anyone can send lamports to any address), which
        // makes `create_account` fail. Top up to rent-exemption, then allocate and
        // assign explicitly — the same fallback Anchor's `init` uses.
        if current < lamports {
            system_program::transfer(
                CpiContext::new(
                    system_program.to_account_info(),
                    system_program::Transfer {
                        from: payer.to_account_info(),
                        to: info.clone(),
                    },
                ),
                lamports - current,
            )?;
        }
        system_program::allocate(
            CpiContext::new_with_signer(
                system_program.to_account_info(),
                system_program::Allocate {
                    account_to_allocate: info.clone(),
                },
                signer_seeds,
            ),
            space as u64,
        )?;
        system_program::assign(
            CpiContext::new_with_signer(
                system_program.to_account_info(),
                system_program::Assign {
                    account_to_assign: info.clone(),
                },
                signer_seeds,
            ),
            &crate::ID,
        )?;
    }

    let position = OrderbookPosition {
        market: market.key(),
        user,
        yes_shares: 0,
        no_shares: 0,
        _reserved: [0u8; 16],
    };
    let mut data = info.try_borrow_mut_data()?;
    let mut cursor: &mut [u8] = &mut data;
    position.try_serialize(&mut cursor)?;

    Ok(position)
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
