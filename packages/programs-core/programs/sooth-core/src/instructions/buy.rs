//! `buy` — place or match a YES (SIDE_FOR=0) or NO (SIDE_AGAINST=1) order on the CLOB.
//!
//! The `side` parameter selects which book_side PDA is opened.

use anchor_lang::prelude::*;
use anchor_lang::{emit_cpi, event_cpi};
use anchor_lang::system_program;
use anchor_spl::token::{Token, TokenAccount};
use crate::constants::BASE_TOKEN_MINT;

use crate::error::SoothCoreError;
use crate::events::{DustOrderSkipped, FillRecord, OrderPlaced, OrdersFilled};
use crate::matching::{match_buy, MatchAccounts};
use crate::math::{min_resting_order_for_tick, resting_cost_base, MAX_TICK, MIN_TICK, NUM_TICKS};
use crate::state::{
    encode_order_id, require_not_paused, BookSide, InlineOrder, Market, MarketBook,
    ProtocolConfig, MAX_ORDERS_PER_TICK,
};

/// `#[event_cpi]` replaces the `sooth_log` program — see the note below
/// `handler`. It appends `event_authority` + `program` to the account list.
#[event_cpi]
#[derive(Accounts)]
#[instruction(side: u8, tick: u16)]
pub struct BuyOrder<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init_if_needed,
        payer = taker,
        space = MarketBook::SPACE,
        seeds = [b"market_book", market.market_id.as_ref()],
        bump,
        constraint = market_book.market == Pubkey::default()
            || market_book.market == market.key() @ SoothCoreError::OrderIdSeedMismatch,
    )]
    pub market_book: Box<Account<'info, MarketBook>>,

    /// CHECK: PDA seed-bound here; initialized after the dust check.
    #[account(
        mut,
        seeds = [b"book_side", market.market_id.as_ref(), &[side], &tick.to_le_bytes()],
        bump,
    )]
    pub book_side: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault @ SoothCoreError::BaseMintDrift,
    )]
    pub market_usdc_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: derived via seeds; signs vault outflows.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"market_fee_pool", market.market_id.as_ref()],
        bump,
        constraint = market_fee_pool.mint == market_usdc_vault.mint
            @ SoothCoreError::BaseMintDrift,
    )]
    pub market_fee_pool: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = market_usdc_vault.mint,
        token::authority = taker,
    )]
    pub taker_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA seed-bound under crate::ID; lazily initialized inline.
    #[account(
        mut,
        seeds = [
            b"orderbook_position",
            market.market_id.as_ref(),
            taker.key().as_ref()
        ],
        bump,
    )]
    pub taker_orderbook_position: UncheckedAccount<'info>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,

}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, BuyOrder<'info>>,
    side: u8,
    tick: u16,
    amount: u128,
    escrow: bool,
    match_limit_arg: u32,
) -> Result<()> {
    let remaining_accounts = ctx.remaining_accounts;
    let mut fills: Vec<FillRecord> = Vec::new();
    let result = buy_handler(
        &ctx.accounts.taker,
        ctx.accounts.market.as_ref(),
        ctx.accounts.market_book.as_mut(),
        &ctx.accounts.book_side,
        ctx.accounts.market_usdc_vault.as_ref(),
        &ctx.accounts.vault_authority,
        ctx.accounts.market_fee_pool.as_ref(),
        ctx.accounts.taker_usdc_ata.as_ref(),
        &ctx.accounts.taker_orderbook_position,
        ctx.accounts.protocol_config.as_ref(),
        &ctx.accounts.system_program,
        &ctx.accounts.token_program,
        &ctx.accounts.rent,
        ctx.bumps.book_side,
        side,
        tick,
        amount,
        escrow,
        match_limit_arg,
        remaining_accounts,
        &mut fills,
    );
    result?;

    if fills.is_empty() {
        return Ok(());
    }
    // Instruction data is capped at 10 KiB; a fill is ~96 bytes and the
    // transaction-size limit caps fills per tx at 5, so this is unreachable in
    // practice and exists so a future change fails loudly rather than silently
    // truncating.
    let approx = 8 + 32 + 32 + 1 + 4 + fills.len() * 96;
    require!(approx <= 10 * 1024, SoothCoreError::EventTooLarge);

    emit_cpi!(OrdersFilled {
        market: ctx.accounts.market.key(),
        taker: ctx.accounts.taker.key(),
        taker_side: side,
        fills,
    });
    Ok(())
}

// ── Why there is no `sooth_log` any more ─────────────────────────────────
//
// The batched `OrdersFilled` payload used to be `invoke`d into a separate
// no-op program so it would land in `meta.innerInstructions`. Two reasons were
// given, and both were true when written:
//
//   1. "a second program is unavoidable, because a program cannot CPI into
//      itself." Solana permits **direct self recursion**, which is exactly what
//      Anchor's `#[event_cpi]` / `emit_cpi!` do. This premise was simply wrong.
//
//   2. "`emit_cpi!` allocates per event; the P0.1 spike proved it OOMs this
//      path even batched." That was correct against the **32 KB default heap**.
//      This program now installs a 256 KB heap frame (`lib.rs`), which is
//      mandatory on every instruction — so the constraint that justified the
//      second program no longer exists.
//
// `emit_cpi!` gives the same guarantee (payload in an inner instruction, not a
// truncatable program log) with no second program, no second `declare_id`, and
// no second deploy.

pub(crate) fn buy_handler<'info>(
    taker: &Signer<'info>,
    market: &Account<'info, Market>,
    market_book: &mut Account<'info, MarketBook>,
    book_side: &UncheckedAccount<'info>,
    market_usdc_vault: &Account<'info, TokenAccount>,
    vault_authority: &UncheckedAccount<'info>,
    market_fee_pool: &Account<'info, TokenAccount>,
    taker_usdc_ata: &Account<'info, TokenAccount>,
    taker_orderbook_position: &UncheckedAccount<'info>,
    protocol_config: &Account<'info, ProtocolConfig>,
    system_program: &Program<'info, System>,
    token_program: &Program<'info, Token>,
    rent: &Sysvar<'info, Rent>,
    book_side_bump: u8,
    side: u8,
    tick: u16,
    amount: u128,
    escrow: bool,
    match_limit_arg: u32,
    remaining_accounts: &[AccountInfo<'info>],
    fills: &mut Vec<FillRecord>,
) -> Result<()> {
    require_not_paused(protocol_config)?;
    require!(
        (MIN_TICK..=MAX_TICK).contains(&tick),
        SoothCoreError::InvalidTick
    );
    require!(amount > 0, SoothCoreError::ZeroAmount);

    require!(market.is_open(), SoothCoreError::MarketNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(now < market.deadline, SoothCoreError::TradingClosed);

    init_or_check_market_book(market_book, market.key(), market_usdc_vault)?;

    if escrow {
        debit_shares_for_order(
            taker_orderbook_position,
            taker,
            system_program,
            rent,
            market,
            side ^ 1,
            amount,
        )?;
    }

    let match_limit = if match_limit_arg == 0 {
        u32::MAX
    } else {
        match_limit_arg
    };
    let match_accounts = MatchAccounts {
        taker,
        market,
        vault_authority,
        market_usdc_vault,
        taker_usdc_ata,
        taker_orderbook_position,
        protocol_config,
        system_program,
        token_program,
        rent,
    };
    let remaining = match_buy(
        market_book,
        &match_accounts,
        side,
        tick,
        amount,
        escrow,
        match_limit,
        remaining_accounts,
        fills,
    )?;

    if remaining == 0 {
        flush_accumulators(
            market_book,
            market,
            vault_authority,
            market_usdc_vault,
            taker_usdc_ata,
            market_fee_pool,
            taker,
            token_program,
        )?;
        return Ok(());
    }

    let value_tick = if escrow { NUM_TICKS - tick } else { tick };
    if remaining < min_resting_order_for_tick(value_tick)? {
        if escrow {
            credit_shares_for_order(
                taker_orderbook_position,
                taker,
                system_program,
                rent,
                market,
                side ^ 1,
                remaining,
            )?;
        }
        emit!(DustOrderSkipped {
            market: market.key(),
            side,
            tick,
            user: taker.key(),
            amount: remaining,
            escrow,
        });
        flush_accumulators(
            market_book,
            market,
            vault_authority,
            market_usdc_vault,
            taker_usdc_ata,
            market_fee_pool,
            taker,
            token_program,
        )?;
        return Ok(());
    }

    if !escrow {
        let resting_cost = resting_cost_base(remaining, tick)?;
        deposit_for_order(taker_usdc_ata, market_usdc_vault, taker, token_program, resting_cost)?;
    }

    let mut bs = load_or_init_book_side(
        book_side,
        book_side_bump,
        market.key(),
        market,
        side,
        tick,
        taker,
        system_program,
    )?;
    require!(
        bs.orders.len() < MAX_ORDERS_PER_TICK,
        SoothCoreError::BookSideFull
    );
    grow_book_side_for_append(book_side, taker, system_program, bs.orders.len())?;

    let seq = market_book.next_order_id;
    let order_id = encode_order_id(side, tick, seq);
    market_book.next_order_id =
        seq.checked_add(1).ok_or(error!(SoothCoreError::MathOverflow))?;
    bs.orders.push(InlineOrder {
        id: order_id,
        maker: taker.key(),
        amount: remaining,
        escrow,
        _pad: [0; 3],
    });

    market_book.bitmap_mut(side).set_bit(tick);
    emit!(OrderPlaced {
        market: market.key(),
        side,
        tick,
        maker: taker.key(),
        amount: remaining,
        escrow,
        order_id,
    });

    save_book_side(book_side, &bs)?;
    flush_accumulators(
        market_book,
        market,
        vault_authority,
        market_usdc_vault,
        taker_usdc_ata,
        market_fee_pool,
        taker,
        token_program,
    )?;
    Ok(())
}

fn init_or_check_market_book(
    book: &mut MarketBook,
    market_key: Pubkey,
    market_usdc_vault: &TokenAccount,
) -> Result<()> {
    if book.market == Pubkey::default() {
        book.market = market_key;
        book.base_token_mint = market_usdc_vault.mint;
        require_keys_eq!(
            book.base_token_mint,
            BASE_TOKEN_MINT,
            SoothCoreError::WrongBaseMint
        );
        book.registrar = crate::ID;
        book.next_order_id = 1;
        book.pending_fees = 0;
        book.pending_taker_payout = 0;
    }
    require_keys_eq!(
        book.market,
        market_key,
        SoothCoreError::OrderIdSeedMismatch
    );
    require_keys_eq!(
        book.base_token_mint,
        market_usdc_vault.mint,
        SoothCoreError::BaseMintDrift
    );
    require!(
        book.pending_fees == 0 && book.pending_taker_payout == 0,
        SoothCoreError::AccumulatorNotReset
    );
    Ok(())
}

fn load_or_init_book_side<'info>(
    book_side: &UncheckedAccount<'info>,
    book_side_bump: u8,
    market_key: Pubkey,
    market: &Market,
    side: u8,
    tick: u16,
    taker: &Signer<'info>,
    system_program: &Program<'info, System>,
) -> Result<BookSide> {
    let info = book_side.to_account_info();
    if info.data_is_empty() {
        let space = BookSide::space_for(1);
        let lamports = Rent::get()?.minimum_balance(space);
        let side_seed = [side];
        let tick_seed = tick.to_le_bytes();
        let bump_seed = [book_side_bump];
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"book_side",
            market.market_id.as_ref(),
            side_seed.as_ref(),
            tick_seed.as_ref(),
            bump_seed.as_ref(),
        ]];
        system_program::create_account(
            CpiContext::new_with_signer(
                system_program.to_account_info(),
                system_program::CreateAccount {
                    from: taker.to_account_info(),
                    to: info.clone(),
                },
                signer_seeds,
            ),
            lamports,
            space as u64,
            &crate::ID,
        )?;
        return Ok(BookSide {
            _reserved: [0u8; 32],
            market: market_key,
            side,
            tick,
            head_index: 0,
            orders: Vec::new(),
        });
    }
    let data = info.try_borrow_data()?;
    let mut data_slice: &[u8] = &data;
    use anchor_lang::AccountDeserialize;
    let book_side_val = BookSide::try_deserialize(&mut data_slice)?;
    require_keys_eq!(
        book_side_val.market,
        market_key,
        SoothCoreError::OrderIdSeedMismatch
    );
    require!(
        book_side_val.side == side && book_side_val.tick == tick,
        SoothCoreError::OrderIdSeedMismatch
    );
    Ok(book_side_val)
}

fn grow_book_side_for_append<'info>(
    book_side: &UncheckedAccount<'info>,
    taker: &Signer<'info>,
    system_program: &Program<'info, System>,
    current_len: usize,
) -> Result<()> {
    let info = book_side.to_account_info();
    let new_space = BookSide::space_for(current_len + 1);
    let required_lamports = Rent::get()?.minimum_balance(new_space);
    let current_lamports = info.lamports();
    if required_lamports > current_lamports {
        system_program::transfer(
            CpiContext::new(
                system_program.to_account_info(),
                system_program::Transfer {
                    from: taker.to_account_info(),
                    to: info.clone(),
                },
            ),
            required_lamports - current_lamports,
        )?;
    }
    if info.data_len() < new_space {
        info.realloc(new_space, false)?;
    }
    Ok(())
}

fn save_book_side(book_side: &UncheckedAccount<'_>, bs: &BookSide) -> Result<()> {
    let info = book_side.to_account_info();
    let mut data = info.try_borrow_mut_data()?;
    use anchor_lang::AccountSerialize;
    bs.try_serialize(&mut &mut data[..])?;
    Ok(())
}

fn deposit_for_order<'info>(
    taker_usdc_ata: &Account<'info, TokenAccount>,
    market_usdc_vault: &Account<'info, TokenAccount>,
    taker: &Signer<'info>,
    token_program: &Program<'info, Token>,
    base_units: u64,
) -> Result<()> {
    use anchor_spl::token::{self, Transfer};
    token::transfer(
        CpiContext::new(
            token_program.to_account_info(),
            Transfer {
                from: taker_usdc_ata.to_account_info(),
                to: market_usdc_vault.to_account_info(),
                authority: taker.to_account_info(),
            },
        ),
        base_units,
    )
}

fn debit_shares_for_order<'info>(
    taker_orderbook_position: &UncheckedAccount<'info>,
    taker: &Signer<'info>,
    system_program: &Program<'info, System>,
    rent: &Sysvar<'info, Rent>,
    market: &Account<'info, Market>,
    outcome: u8,
    amount: u128,
) -> Result<()> {
    use crate::instructions::orderbook_common::debit_shares;
    use crate::state::OrderbookPosition;
    use anchor_lang::{AccountDeserialize, AccountSerialize};

    let info = taker_orderbook_position.to_account_info();
    ensure_position_exists(info.clone(), taker, system_program, rent, market)?;
    let data = info.try_borrow_mut_data()?;
    let mut slice: &[u8] = &data;
    let mut pos = OrderbookPosition::try_deserialize(&mut slice)
        .map_err(|_| error!(SoothCoreError::Unauthorized))?;
    drop(data);
    debit_shares(&mut pos, outcome, amount)?;
    let mut data = info.try_borrow_mut_data()?;
    pos.try_serialize(&mut &mut data[..])?;
    Ok(())
}

fn credit_shares_for_order<'info>(
    taker_orderbook_position: &UncheckedAccount<'info>,
    taker: &Signer<'info>,
    system_program: &Program<'info, System>,
    rent: &Sysvar<'info, Rent>,
    market: &Account<'info, Market>,
    outcome: u8,
    amount: u128,
) -> Result<()> {
    use crate::instructions::orderbook_common::credit_shares;
    use crate::state::OrderbookPosition;
    use anchor_lang::{AccountDeserialize, AccountSerialize};

    let info = taker_orderbook_position.to_account_info();
    ensure_position_exists(info.clone(), taker, system_program, rent, market)?;
    let data = info.try_borrow_mut_data()?;
    let mut slice: &[u8] = &data;
    let mut pos = OrderbookPosition::try_deserialize(&mut slice)
        .map_err(|_| error!(SoothCoreError::Unauthorized))?;
    drop(data);
    credit_shares(&mut pos, outcome, amount)?;
    let mut data = info.try_borrow_mut_data()?;
    pos.try_serialize(&mut &mut data[..])?;
    Ok(())
}

fn ensure_position_exists<'info>(
    info: AccountInfo<'info>,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
    rent: &Sysvar<'info, Rent>,
    market: &Account<'info, Market>,
) -> Result<()> {
    use crate::instructions::orderbook_common::create_orderbook_position;

    if info.data_is_empty() {
        create_orderbook_position(&info, market, payer.key(), payer, system_program, rent)?;
    }
    Ok(())
}

fn flush_accumulators<'info>(
    market_book: &mut MarketBook,
    market: &Account<'info, Market>,
    vault_authority: &UncheckedAccount<'info>,
    market_usdc_vault: &Account<'info, TokenAccount>,
    taker_usdc_ata: &Account<'info, TokenAccount>,
    market_fee_pool: &Account<'info, TokenAccount>,
    _taker: &Signer<'info>,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    use anchor_spl::token::{self, Transfer};

    let taker_payout = market_book.pending_taker_payout;
    if taker_payout > 0 {
        let amount: u64 = taker_payout
            .try_into()
            .map_err(|_| error!(SoothCoreError::MathOverflow))?;
        let market_id = market.market_id;
        let vault_authority_bump = market.vault_authority_bump;
        let signer_seeds: &[&[&[u8]]] =
            &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: market_usdc_vault.to_account_info(),
                    to: taker_usdc_ata.to_account_info(),
                    authority: vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
        market_book.pending_taker_payout = 0;
    }

    let pending_fees = market_book.pending_fees;
    if pending_fees > 0 {
        let amount: u64 = pending_fees
            .try_into()
            .map_err(|_| error!(SoothCoreError::MathOverflow))?;
        let market_id = market.market_id;
        let vault_authority_bump = market.vault_authority_bump;
        let signer_seeds: &[&[&[u8]]] =
            &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: market_usdc_vault.to_account_info(),
                    to: market_fee_pool.to_account_info(),
                    authority: vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
        market_book.pending_fees = 0;
    }

    Ok(())
}
