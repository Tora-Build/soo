//! `matching` — tick-level order matching engine for the CLOB.
//!
//! `fill_order` is a direct call to `fill_order_internal`, which returns
//! `(fee_base_delta, taker_payout_delta)` as a tuple. `FILL_BUNDLE_LEN` is 3
//! (book_side, maker_position, maker_usdc_ata per fill). Both owner checks
//! use `crate::ID`.

use anchor_lang::prelude::*;
use anchor_lang::{AccountDeserialize, Discriminator};
use anchor_spl::token::{Token, TokenAccount};
use crate::constants::BASE_TOKEN_MINT;

use crate::error::SoothCoreError;
use crate::events::FillRecord;
use crate::math::{MAX_TICK, NUM_TICKS};
use crate::state::{
    BookSide, InlineOrder, Market, MarketBook, OrderbookPosition, ProtocolConfig,
    BOOK_SIDE_HEAD_INDEX_OFFSET, BOOK_SIDE_HEADER_SPACE, BOOK_SIDE_MARKET_OFFSET,
    BOOK_SIDE_ORDERS_LEN_OFFSET, BOOK_SIDE_SIDE_OFFSET, BOOK_SIDE_TICK_OFFSET,
    INLINE_ORDER_SPACE,
};

pub struct MatchTickResult {
    pub remaining: u128,
    pub match_limit_remaining: u32,
    pub next_fill_index: usize,
}

pub struct MatchAccounts<'a, 'info> {
    pub taker: &'a Signer<'info>,
    pub market: &'a Account<'info, Market>,
    pub vault_authority: &'a UncheckedAccount<'info>,
    pub market_usdc_vault: &'a Account<'info, TokenAccount>,
    pub taker_usdc_ata: &'a Account<'info, TokenAccount>,
    pub taker_orderbook_position: &'a UncheckedAccount<'info>,
    pub protocol_config: &'a Account<'info, ProtocolConfig>,
    pub system_program: &'a Program<'info, System>,
    pub token_program: &'a Program<'info, Token>,
    pub rent: &'a Sysvar<'info, Rent>,
}

pub fn match_buy<'info>(
    book: &mut MarketBook,
    accounts: &MatchAccounts<'_, 'info>,
    taker_side: u8,
    taker_tick: u16,
    mut amount: u128,
    taker_escrow: bool,
    mut match_limit: u32,
    remaining_accounts: &[AccountInfo<'info>],
    fills: &mut Vec<FillRecord>,
) -> Result<u128> {
    require!(
        remaining_accounts.len() % FILL_BUNDLE_LEN == 0,
        SoothCoreError::WrongBundleArity
    );

    let opp_side = taker_side ^ 1;
    let min_opp_tick = NUM_TICKS - taker_tick;
    let mut opp_tick = book.bitmap(opp_side).find_next_down(NUM_TICKS);
    let mut fill_index: usize = 0;

    while amount > 0 && opp_tick >= min_opp_tick && opp_tick <= MAX_TICK {
        let result = match_at_tick(
            book,
            accounts,
            remaining_accounts,
            fill_index,
            taker_side,
            opp_side,
            taker_tick,
            opp_tick,
            amount,
            taker_escrow,
            match_limit,
            fills,
        )?;
        amount = result.remaining;
        match_limit = result.match_limit_remaining;
        fill_index = result.next_fill_index;

        if match_limit == 0 || opp_tick == 0 {
            break;
        }
        opp_tick = book.bitmap(opp_side).find_next_down(opp_tick);
    }

    Ok(amount)
}

#[allow(clippy::too_many_arguments)]
pub fn match_at_tick<'info>(
    book: &mut MarketBook,
    accounts: &MatchAccounts<'_, 'info>,
    remaining_accounts: &[AccountInfo<'info>],
    mut fill_index: usize,
    taker_side: u8,
    opp_side: u8,
    taker_tick: u16,
    opp_tick: u16,
    mut remaining: u128,
    taker_escrow: bool,
    mut match_limit: u32,
    fills: &mut Vec<FillRecord>,
) -> Result<MatchTickResult> {
    let bundle_count = remaining_accounts.len() / FILL_BUNDLE_LEN;
    if fill_index >= bundle_count {
        return Ok(MatchTickResult {
            remaining,
            match_limit_remaining: match_limit,
            next_fill_index: fill_index,
        });
    }

    let first_base = validate_fill_bundle(
        remaining_accounts,
        fill_index,
        accounts.market,
        opp_side,
        opp_tick,
        None,
    )?;
    let book_side_info = &remaining_accounts[first_base];
    let header = read_book_side_header(book_side_info)?;
    require_keys_eq!(
        header.market,
        accounts.market.key(),
        SoothCoreError::MissingCrossingBookSide
    );
    require!(
        header.side == opp_side && header.tick == opp_tick,
        SoothCoreError::MissingCrossingBookSide
    );

    let mut head = header.head_index as usize;
    while remaining > 0 && head < header.orders_len && match_limit > 0 {
        let order = read_inline_order(book_side_info, head)?;
        if order.amount == 0 {
            head += 1;
            continue;
        }
        if fill_index >= bundle_count {
            break;
        }

        let maker = order.maker;
        let maker_escrow = order.escrow;
        let maker_amount = order.amount;
        let bundle_base = validate_fill_bundle(
            remaining_accounts,
            fill_index,
            accounts.market,
            opp_side,
            opp_tick,
            Some(maker),
        )?;
        let fill = remaining.min(maker_amount);

        // Returns (fee_base_delta, taker_payout_delta).
        let (fee_base_delta, taker_payout_delta) = crate::instructions::fill_order_internal(
            accounts.market,
            accounts.vault_authority,
            accounts.market_usdc_vault,
            accounts.taker_usdc_ata,
            &remaining_accounts[bundle_base + 2],
            accounts.taker_orderbook_position,
            &remaining_accounts[bundle_base + 1],
            accounts.taker,
            accounts.protocol_config,
            accounts.token_program,
            accounts.system_program,
            accounts.rent,
            maker,
            taker_side,
            fill,
            taker_tick,
            opp_tick,
            taker_escrow,
            maker_escrow,
        )?;

        book.pending_fees = book
            .pending_fees
            .checked_add(fee_base_delta)
            .ok_or(error!(SoothCoreError::MathOverflow))?;
        book.pending_taker_payout = book
            .pending_taker_payout
            .checked_add(taker_payout_delta)
            .ok_or(error!(SoothCoreError::MathOverflow))?;

        // Ticks are stored as (yes, no) regardless of which side the taker
        // took, so consumers can price the trade without re-deriving sides.
        let (yes_tick, no_tick) = if taker_side == 0 {
            (taker_tick, opp_tick)
        } else {
            (opp_tick, taker_tick)
        };
        fills.push(FillRecord {
            maker,
            maker_order_id: order.id,
            yes_tick,
            no_tick,
            amount: fill,
            surplus: taker_payout_delta,
            ts: Clock::get()?.unix_timestamp,
        });

        let remaining_maker_amount = maker_amount
            .checked_sub(fill)
            .ok_or(error!(SoothCoreError::MathOverflow))?;
        write_order_amount(book_side_info, head, remaining_maker_amount)?;
        remaining = remaining
            .checked_sub(fill)
            .ok_or(error!(SoothCoreError::MathOverflow))?;
        if remaining_maker_amount == 0 {
            head += 1;
        }
        match_limit -= 1;
        fill_index += 1;
    }

    write_head_index(book_side_info, head)?;
    if head == header.orders_len {
        book.bitmap_mut(opp_side).clear_bit(opp_tick);
    }

    Ok(MatchTickResult {
        remaining,
        match_limit_remaining: match_limit,
        next_fill_index: fill_index,
    })
}

/// Number of accounts per fill bundle: [book_side, maker_position, maker_usdc_ata].
pub const FILL_BUNDLE_LEN: usize = 3;

fn validate_fill_bundle<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    fill_index: usize,
    market: &Account<'info, Market>,
    opp_side: u8,
    opp_tick: u16,
    expected_maker: Option<Pubkey>,
) -> Result<usize> {
    let base = fill_index
        .checked_mul(FILL_BUNDLE_LEN)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    let book_side = remaining_accounts
        .get(base)
        .ok_or(error!(SoothCoreError::MissingCrossingBookSide))?;
    let maker_position = remaining_accounts
        .get(base + 1)
        .ok_or(error!(SoothCoreError::MakerAccountMismatch))?;
    let maker_usdc_ata = remaining_accounts
        .get(base + 2)
        .ok_or(error!(SoothCoreError::MakerAccountMismatch))?;

    let side_seed = [opp_side];
    let tick_seed = opp_tick.to_le_bytes();
    let expected_book_side = Pubkey::find_program_address(
        &[
            b"book_side",
            market.market_id.as_ref(),
            side_seed.as_ref(),
            tick_seed.as_ref(),
        ],
        &crate::ID,
    )
    .0;
    require_keys_eq!(
        *book_side.key,
        expected_book_side,
        SoothCoreError::MissingCrossingBookSide
    );
    require_keys_eq!(
        *book_side.owner,
        crate::ID,
        SoothCoreError::MissingCrossingBookSide
    );

    if let Some(maker) = expected_maker {
        let expected_position = Pubkey::find_program_address(
            &[
                b"orderbook_position",
                market.market_id.as_ref(),
                maker.as_ref(),
            ],
            &crate::ID,
        )
        .0;
        require_keys_eq!(
            *maker_position.key,
            expected_position,
            SoothCoreError::MakerAccountMismatch
        );
        if !maker_position.data_is_empty() {
            require_keys_eq!(
                *maker_position.owner,
                crate::ID,
                SoothCoreError::MakerAccountMismatch
            );
            let data = maker_position.try_borrow_data()?;
            let mut data_slice: &[u8] = &data;
            let maker_position_account = OrderbookPosition::try_deserialize(&mut data_slice)
                .map_err(|_| error!(SoothCoreError::MakerAccountMismatch))?;
            require_keys_eq!(
                maker_position_account.user,
                maker,
                SoothCoreError::MakerAccountMismatch
            );
        }

        let data = maker_usdc_ata.try_borrow_data()?;
        let mut data_slice: &[u8] = &data;
        let maker_usdc = TokenAccount::try_deserialize(&mut data_slice)
            .map_err(|_| error!(SoothCoreError::MakerAccountMismatch))?;
        require_keys_eq!(
            maker_usdc.owner,
            maker,
            SoothCoreError::MakerAccountMismatch
        );
        require_keys_eq!(
            maker_usdc.mint,
            BASE_TOKEN_MINT,
            SoothCoreError::MakerAccountMismatch
        );
    }

    Ok(base)
}

struct BookSideHeader {
    market: Pubkey,
    side: u8,
    tick: u16,
    head_index: u32,
    orders_len: usize,
}

fn read_book_side_header(info: &AccountInfo) -> Result<BookSideHeader> {
    let data = info.try_borrow_data()?;
    require!(
        data.len() >= BOOK_SIDE_HEADER_SPACE,
        SoothCoreError::MissingCrossingBookSide
    );
    require!(
        &data[..8] == BookSide::discriminator().as_ref(),
        SoothCoreError::MissingCrossingBookSide
    );
    let market = Pubkey::new_from_array(
        data[BOOK_SIDE_MARKET_OFFSET..BOOK_SIDE_MARKET_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(SoothCoreError::MissingCrossingBookSide))?,
    );
    let side = data[BOOK_SIDE_SIDE_OFFSET];
    let tick = u16::from_le_bytes(
        data[BOOK_SIDE_TICK_OFFSET..BOOK_SIDE_TICK_OFFSET + 2]
            .try_into()
            .map_err(|_| error!(SoothCoreError::MissingCrossingBookSide))?,
    );
    let head_index = u32::from_le_bytes(
        data[BOOK_SIDE_HEAD_INDEX_OFFSET..BOOK_SIDE_HEAD_INDEX_OFFSET + 4]
            .try_into()
            .map_err(|_| error!(SoothCoreError::MissingCrossingBookSide))?,
    );
    let orders_len = u32::from_le_bytes(
        data[BOOK_SIDE_ORDERS_LEN_OFFSET..BOOK_SIDE_ORDERS_LEN_OFFSET + 4]
            .try_into()
            .map_err(|_| error!(SoothCoreError::MissingCrossingBookSide))?,
    ) as usize;
    require!(
        data.len() >= BOOK_SIDE_HEADER_SPACE + INLINE_ORDER_SPACE * orders_len,
        SoothCoreError::MissingCrossingBookSide
    );
    Ok(BookSideHeader {
        market,
        side,
        tick,
        head_index,
        orders_len,
    })
}

fn order_offset(index: usize) -> Result<usize> {
    index
        .checked_mul(INLINE_ORDER_SPACE)
        .and_then(|offset| BOOK_SIDE_HEADER_SPACE.checked_add(offset))
        .ok_or(error!(SoothCoreError::MathOverflow))
}

fn read_inline_order(info: &AccountInfo, index: usize) -> Result<InlineOrder> {
    let data = info.try_borrow_data()?;
    let offset = order_offset(index)?;
    let order_data = data
        .get(offset..offset + INLINE_ORDER_SPACE)
        .ok_or(error!(SoothCoreError::MissingCrossingBookSide))?;
    Ok(InlineOrder {
        id: u64::from_le_bytes(
            order_data[0..8]
                .try_into()
                .map_err(|_| error!(SoothCoreError::MissingCrossingBookSide))?,
        ),
        maker: Pubkey::new_from_array(
            order_data[8..40]
                .try_into()
                .map_err(|_| error!(SoothCoreError::MissingCrossingBookSide))?,
        ),
        amount: u128::from_le_bytes(
            order_data[40..56]
                .try_into()
                .map_err(|_| error!(SoothCoreError::MissingCrossingBookSide))?,
        ),
        escrow: order_data[56] != 0,
        _pad: order_data[57..60]
            .try_into()
            .map_err(|_| error!(SoothCoreError::MissingCrossingBookSide))?,
    })
}

fn write_order_amount(info: &AccountInfo, index: usize, amount: u128) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let amount_offset = order_offset(index)?
        .checked_add(40)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    data.get_mut(amount_offset..amount_offset + 16)
        .ok_or(error!(SoothCoreError::MissingCrossingBookSide))?
        .copy_from_slice(&amount.to_le_bytes());
    Ok(())
}

fn write_head_index(info: &AccountInfo, head: usize) -> Result<()> {
    let head = u32::try_from(head).map_err(|_| error!(SoothCoreError::MathOverflow))?;
    let mut data = info.try_borrow_mut_data()?;
    data.get_mut(43..47)
        .ok_or(error!(SoothCoreError::MissingCrossingBookSide))?
        .copy_from_slice(&head.to_le_bytes());
    Ok(())
}
