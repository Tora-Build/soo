use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{Token, TokenAccount};
use sooth_market::program::SoothMarket;
use sooth_market::state::Market;
use sooth_protocol_types::ids::{BASE_TOKEN_MINT, SOOTH_BOOK_PROGRAM_ID};

use crate::error::CoreError;
use crate::events::{DustOrderSkipped, OrderPlaced};
use crate::matching::{match_buy, MatchAccounts};
use crate::math::{min_resting_order_for_tick, resting_cost_base, MAX_TICK, MIN_TICK, NUM_TICKS};
use crate::state::{
    encode_order_id, BookSide, InlineOrder, MarketBook, MAX_ORDERS_PER_TICK, SIDE_AGAINST, SIDE_FOR,
};

#[derive(Accounts)]
#[instruction(tick: u16)]
pub struct BuyYesOrder<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init_if_needed,
        payer = taker,
        space = MarketBook::SPACE,
        seeds = [b"market_book", market.market_id.as_ref()],
        bump,
        constraint = market_book.market == Pubkey::default()
            || market_book.market == market.key() @ CoreError::OrderIdSeedMismatch,
    )]
    pub market_book: Box<Account<'info, MarketBook>>,

    /// CHECK: PDA seed-bound here; initialized after the dust check so dust
    /// skips do not allocate pooled rent.
    #[account(
        mut,
        seeds = [b"book_side", market.market_id.as_ref(), &[SIDE_FOR], &tick.to_le_bytes()],
        bump,
    )]
    pub book_side: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault @ CoreError::BaseMintDrift,
    )]
    pub market_usdc_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: derived via sooth_market seeds; signs vault outflows there.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
        seeds::program = sooth_market::ID,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"market_fee_pool", market.market_id.as_ref()],
        bump,
        seeds::program = sooth_protocol_types::SOOTH_LAUNCHPAD_PROGRAM_ID,
        constraint = market_fee_pool.mint == market_usdc_vault.mint
            @ CoreError::BaseMintDrift,
    )]
    pub market_fee_pool: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = market_usdc_vault.mint,
        token::authority = taker,
    )]
    pub taker_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA seed-bound under sooth_market; the sooth_market CPI lazily
    /// initializes and owns the account.
    #[account(
        mut,
        seeds = [
            b"orderbook_position",
            market.market_id.as_ref(),
            taker.key().as_ref()
        ],
        bump,
        seeds::program = sooth_market::ID,
    )]
    pub taker_orderbook_position: UncheckedAccount<'info>,

    /// CHECK: PDA + owner constraints bind this to sooth_launchpad's singleton.
    #[account(
        seeds = [b"protocol_config"],
        bump,
        seeds::program = sooth_protocol_types::SOOTH_LAUNCHPAD_PROGRAM_ID,
        owner = sooth_protocol_types::SOOTH_LAUNCHPAD_PROGRAM_ID,
    )]
    pub protocol_config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
    pub sooth_market_program: Program<'info, SoothMarket>,

    /// CHECK: address-pinned and forwarded to sooth_market CPI gates.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(tick: u16)]
pub struct BuyNoOrder<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init_if_needed,
        payer = taker,
        space = MarketBook::SPACE,
        seeds = [b"market_book", market.market_id.as_ref()],
        bump,
        constraint = market_book.market == Pubkey::default()
            || market_book.market == market.key() @ CoreError::OrderIdSeedMismatch,
    )]
    pub market_book: Box<Account<'info, MarketBook>>,

    /// CHECK: PDA seed-bound here; initialized after the dust check so dust
    /// skips do not allocate pooled rent.
    #[account(
        mut,
        seeds = [b"book_side", market.market_id.as_ref(), &[SIDE_AGAINST], &tick.to_le_bytes()],
        bump,
    )]
    pub book_side: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault @ CoreError::BaseMintDrift,
    )]
    pub market_usdc_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: derived via sooth_market seeds; signs vault outflows there.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
        seeds::program = sooth_market::ID,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"market_fee_pool", market.market_id.as_ref()],
        bump,
        seeds::program = sooth_protocol_types::SOOTH_LAUNCHPAD_PROGRAM_ID,
        constraint = market_fee_pool.mint == market_usdc_vault.mint
            @ CoreError::BaseMintDrift,
    )]
    pub market_fee_pool: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = market_usdc_vault.mint,
        token::authority = taker,
    )]
    pub taker_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA seed-bound under sooth_market; the sooth_market CPI lazily
    /// initializes and owns the account.
    #[account(
        mut,
        seeds = [
            b"orderbook_position",
            market.market_id.as_ref(),
            taker.key().as_ref()
        ],
        bump,
        seeds::program = sooth_market::ID,
    )]
    pub taker_orderbook_position: UncheckedAccount<'info>,

    /// CHECK: PDA + owner constraints bind this to sooth_launchpad's singleton.
    #[account(
        seeds = [b"protocol_config"],
        bump,
        seeds::program = sooth_protocol_types::SOOTH_LAUNCHPAD_PROGRAM_ID,
        owner = sooth_protocol_types::SOOTH_LAUNCHPAD_PROGRAM_ID,
    )]
    pub protocol_config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
    pub sooth_market_program: Program<'info, SoothMarket>,

    /// CHECK: address-pinned and forwarded to sooth_market CPI gates.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn buy_yes_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, BuyYesOrder<'info>>,
    tick: u16,
    amount: u128,
    escrow: bool,
    match_limit_arg: u32,
) -> Result<()> {
    let remaining_accounts = ctx.remaining_accounts;
    let accounts = BuyAccounts {
        taker: &ctx.accounts.taker,
        market: ctx.accounts.market.as_ref(),
        market_book: ctx.accounts.market_book.as_mut(),
        book_side: &ctx.accounts.book_side,
        market_usdc_vault: ctx.accounts.market_usdc_vault.as_ref(),
        vault_authority: &ctx.accounts.vault_authority,
        market_fee_pool: ctx.accounts.market_fee_pool.as_ref(),
        taker_usdc_ata: ctx.accounts.taker_usdc_ata.as_ref(),
        taker_orderbook_position: &ctx.accounts.taker_orderbook_position,
        protocol_config: &ctx.accounts.protocol_config,
        system_program: &ctx.accounts.system_program,
        token_program: &ctx.accounts.token_program,
        rent: &ctx.accounts.rent,
        sooth_market_program: &ctx.accounts.sooth_market_program,
        instruction_sysvar: &ctx.accounts.instruction_sysvar,
        book_side_bump: ctx.bumps.book_side,
    };
    buy_handler(
        accounts,
        SIDE_FOR,
        tick,
        amount,
        escrow,
        match_limit_arg,
        remaining_accounts,
    )
}

pub fn buy_no_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, BuyNoOrder<'info>>,
    tick: u16,
    amount: u128,
    escrow: bool,
    match_limit_arg: u32,
) -> Result<()> {
    let remaining_accounts = ctx.remaining_accounts;
    let accounts = BuyAccounts {
        taker: &ctx.accounts.taker,
        market: ctx.accounts.market.as_ref(),
        market_book: ctx.accounts.market_book.as_mut(),
        book_side: &ctx.accounts.book_side,
        market_usdc_vault: ctx.accounts.market_usdc_vault.as_ref(),
        vault_authority: &ctx.accounts.vault_authority,
        market_fee_pool: ctx.accounts.market_fee_pool.as_ref(),
        taker_usdc_ata: ctx.accounts.taker_usdc_ata.as_ref(),
        taker_orderbook_position: &ctx.accounts.taker_orderbook_position,
        protocol_config: &ctx.accounts.protocol_config,
        system_program: &ctx.accounts.system_program,
        token_program: &ctx.accounts.token_program,
        rent: &ctx.accounts.rent,
        sooth_market_program: &ctx.accounts.sooth_market_program,
        instruction_sysvar: &ctx.accounts.instruction_sysvar,
        book_side_bump: ctx.bumps.book_side,
    };
    buy_handler(
        accounts,
        SIDE_AGAINST,
        tick,
        amount,
        escrow,
        match_limit_arg,
        remaining_accounts,
    )
}

pub struct BuyAccounts<'a, 'info> {
    pub taker: &'a Signer<'info>,
    pub market: &'a Account<'info, Market>,
    pub market_book: &'a mut Account<'info, MarketBook>,
    pub book_side: &'a UncheckedAccount<'info>,
    pub market_usdc_vault: &'a Account<'info, TokenAccount>,
    pub vault_authority: &'a UncheckedAccount<'info>,
    pub market_fee_pool: &'a Account<'info, TokenAccount>,
    pub taker_usdc_ata: &'a Account<'info, TokenAccount>,
    pub taker_orderbook_position: &'a UncheckedAccount<'info>,
    pub protocol_config: &'a UncheckedAccount<'info>,
    pub system_program: &'a Program<'info, System>,
    pub token_program: &'a Program<'info, Token>,
    pub rent: &'a Sysvar<'info, Rent>,
    pub sooth_market_program: &'a Program<'info, SoothMarket>,
    pub instruction_sysvar: &'a UncheckedAccount<'info>,
    pub book_side_bump: u8,
}

pub fn buy_handler<'info>(
    mut accounts: BuyAccounts<'_, 'info>,
    side: u8,
    tick: u16,
    amount: u128,
    escrow: bool,
    match_limit_arg: u32,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    require!(
        (MIN_TICK..=MAX_TICK).contains(&tick),
        CoreError::InvalidTick
    );
    require!(amount > 0, CoreError::ZeroAmount);
    sooth_market::instructions::orderbook_common::require_before_deadline(accounts.market)?;

    init_or_check_market_book(&mut accounts)?;

    if escrow {
        debit_shares_for_order_before_deadline(&accounts, side ^ 1, amount)?;
    }

    let match_limit = if match_limit_arg == 0 {
        u32::MAX
    } else {
        match_limit_arg
    };
    let match_accounts = MatchAccounts {
        taker: accounts.taker,
        market: accounts.market,
        vault_authority: accounts.vault_authority,
        market_usdc_vault: accounts.market_usdc_vault,
        taker_usdc_ata: accounts.taker_usdc_ata,
        taker_orderbook_position: accounts.taker_orderbook_position,
        protocol_config: accounts.protocol_config,
        system_program: accounts.system_program,
        token_program: accounts.token_program,
        rent: accounts.rent,
        sooth_market_program: accounts.sooth_market_program,
        instruction_sysvar: accounts.instruction_sysvar,
    };
    let remaining = match_buy(
        &mut *accounts.market_book,
        &match_accounts,
        side,
        tick,
        amount,
        escrow,
        match_limit,
        remaining_accounts,
    )?;

    if remaining == 0 {
        flush_accumulators(&mut accounts)?;
        return Ok(());
    }

    let value_tick = if escrow { NUM_TICKS - tick } else { tick };
    if remaining < min_resting_order_for_tick(value_tick)? {
        if escrow {
            credit_shares_for_order(&accounts, side ^ 1, remaining)?;
        }
        emit!(DustOrderSkipped {
            market: accounts.market.key(),
            side,
            tick,
            user: accounts.taker.key(),
            amount: remaining,
            escrow,
        });
        flush_accumulators(&mut accounts)?;
        return Ok(());
    }

    if !escrow {
        let resting_cost_base = resting_cost_base(remaining, tick)?;
        deposit_for_order(&accounts, resting_cost_base)?;
    }

    let mut book_side = load_or_init_book_side(&accounts, side, tick)?;
    require!(
        book_side.orders.len() < MAX_ORDERS_PER_TICK,
        CoreError::BookSideFull
    );
    grow_book_side_for_append(&accounts, book_side.orders.len())?;

    let seq = accounts.market_book.next_order_id;
    let order_id = encode_order_id(side, tick, seq);
    accounts.market_book.next_order_id =
        seq.checked_add(1).ok_or(error!(CoreError::MathOverflow))?;
    book_side.orders.push(InlineOrder {
        id: order_id,
        maker: accounts.taker.key(),
        amount: remaining,
        escrow,
        _pad: [0; 3],
    });

    accounts.market_book.bitmap_mut(side).set_bit(tick);
    emit!(OrderPlaced {
        market: accounts.market.key(),
        side,
        tick,
        maker: accounts.taker.key(),
        amount: remaining,
        escrow,
        order_id,
    });

    save_book_side(&accounts, &book_side)?;
    flush_accumulators(&mut accounts)?;
    Ok(())
}

fn init_or_check_market_book(accounts: &mut BuyAccounts<'_, '_>) -> Result<()> {
    let book = &mut accounts.market_book;
    if book.market == Pubkey::default() {
        book.market = accounts.market.key();
        book.base_token_mint = accounts.market_usdc_vault.mint;
        require_keys_eq!(
            book.base_token_mint,
            BASE_TOKEN_MINT,
            CoreError::WrongBaseMint
        );
        book.registrar = SOOTH_BOOK_PROGRAM_ID;
        book.next_order_id = 1;
        book.pending_fees = 0;
        book.pending_taker_payout = 0;
    }
    require_keys_eq!(
        book.market,
        accounts.market.key(),
        CoreError::OrderIdSeedMismatch
    );
    require_keys_eq!(
        book.base_token_mint,
        accounts.market_usdc_vault.mint,
        CoreError::BaseMintDrift
    );
    require!(
        book.pending_fees == 0 && book.pending_taker_payout == 0,
        CoreError::AccumulatorNotReset
    );
    Ok(())
}

fn load_or_init_book_side<'info>(
    accounts: &BuyAccounts<'_, 'info>,
    side: u8,
    tick: u16,
) -> Result<BookSide> {
    let info = accounts.book_side.to_account_info();
    if info.data_is_empty() {
        let space = BookSide::space_for(1);
        let lamports = Rent::get()?.minimum_balance(space);
        let side_seed = [side];
        let tick_seed = tick.to_le_bytes();
        let bump_seed = [accounts.book_side_bump];
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"book_side",
            accounts.market.market_id.as_ref(),
            side_seed.as_ref(),
            tick_seed.as_ref(),
            bump_seed.as_ref(),
        ]];
        system_program::create_account(
            CpiContext::new_with_signer(
                accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: accounts.taker.to_account_info(),
                    to: info.clone(),
                },
                signer_seeds,
            ),
            lamports,
            space as u64,
            &crate::ID,
        )?;

        return Ok(BookSide {
            market: accounts.market.key(),
            side,
            tick,
            head_index: 0,
            orders: Vec::new(),
        });
    }

    let data = info.try_borrow_data()?;
    let mut data_slice: &[u8] = &data;
    let book_side = BookSide::try_deserialize(&mut data_slice)?;
    require_keys_eq!(
        book_side.market,
        accounts.market.key(),
        CoreError::OrderIdSeedMismatch
    );
    require!(
        book_side.side == side && book_side.tick == tick,
        CoreError::OrderIdSeedMismatch
    );
    Ok(book_side)
}

fn grow_book_side_for_append(accounts: &BuyAccounts<'_, '_>, current_len: usize) -> Result<()> {
    let info = accounts.book_side.to_account_info();
    let new_space = BookSide::space_for(current_len + 1);
    let required_lamports = Rent::get()?.minimum_balance(new_space);
    let current_lamports = info.lamports();
    if required_lamports > current_lamports {
        system_program::transfer(
            CpiContext::new(
                accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: accounts.taker.to_account_info(),
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

fn save_book_side(accounts: &BuyAccounts<'_, '_>, book_side: &BookSide) -> Result<()> {
    let info = accounts.book_side.to_account_info();
    let mut data = info.try_borrow_mut_data()?;
    book_side.try_serialize(&mut &mut data[..])?;
    Ok(())
}

fn debit_shares_for_order_before_deadline(
    accounts: &BuyAccounts<'_, '_>,
    outcome: u8,
    amount: u128,
) -> Result<()> {
    sooth_market::cpi::debit_shares_for_order_before_deadline(
        CpiContext::new(
            accounts.sooth_market_program.to_account_info(),
            sooth_market::cpi::accounts::DebitSharesForOrderBeforeDeadline {
                market: accounts.market.to_account_info(),
                position: accounts.taker_orderbook_position.to_account_info(),
                user: accounts.taker.to_account_info(),
                system_program: accounts.system_program.to_account_info(),
                rent: accounts.rent_account_info(),
                instruction_sysvar: accounts.instruction_sysvar.to_account_info(),
            },
        ),
        outcome,
        amount,
    )
}

fn credit_shares_for_order(
    accounts: &BuyAccounts<'_, '_>,
    outcome: u8,
    amount: u128,
) -> Result<()> {
    sooth_market::cpi::credit_shares_for_order(
        CpiContext::new(
            accounts.sooth_market_program.to_account_info(),
            sooth_market::cpi::accounts::CreditSharesForOrder {
                market: accounts.market.to_account_info(),
                position: accounts.taker_orderbook_position.to_account_info(),
                user: accounts.taker.to_account_info(),
                system_program: accounts.system_program.to_account_info(),
                rent: accounts.rent_account_info(),
                instruction_sysvar: accounts.instruction_sysvar.to_account_info(),
            },
        ),
        outcome,
        amount,
    )
}

fn deposit_for_order(accounts: &BuyAccounts<'_, '_>, base_units: u64) -> Result<()> {
    sooth_market::cpi::deposit_for_order(
        CpiContext::new(
            accounts.sooth_market_program.to_account_info(),
            sooth_market::cpi::accounts::DepositForOrder {
                market: accounts.market.to_account_info(),
                vault: accounts.market_usdc_vault.to_account_info(),
                from_usdc_ata: accounts.taker_usdc_ata.to_account_info(),
                from: accounts.taker.to_account_info(),
                token_program: accounts.token_program.to_account_info(),
                instruction_sysvar: accounts.instruction_sysvar.to_account_info(),
            },
        ),
        base_units,
    )
}

fn flush_accumulators(accounts: &mut BuyAccounts<'_, '_>) -> Result<()> {
    let taker_payout = accounts.market_book.pending_taker_payout;
    if taker_payout > 0 {
        let amount: u64 = taker_payout
            .try_into()
            .map_err(|_| error!(CoreError::MathOverflow))?;
        sooth_market::cpi::withdraw_for_order(
            CpiContext::new(
                accounts.sooth_market_program.to_account_info(),
                sooth_market::cpi::accounts::WithdrawForOrder {
                    market: accounts.market.to_account_info(),
                    vault_authority: accounts.vault_authority.to_account_info(),
                    vault: accounts.market_usdc_vault.to_account_info(),
                    to_usdc_ata: accounts.taker_usdc_ata.to_account_info(),
                    token_program: accounts.token_program.to_account_info(),
                    instruction_sysvar: accounts.instruction_sysvar.to_account_info(),
                },
            ),
            amount,
        )?;
        accounts.market_book.pending_taker_payout = 0;
    }

    let pending_fees = accounts.market_book.pending_fees;
    if pending_fees > 0 {
        let amount: u64 = pending_fees
            .try_into()
            .map_err(|_| error!(CoreError::MathOverflow))?;
        sooth_market::cpi::transfer_fee_to_market_pool_from_book(
            CpiContext::new(
                accounts.sooth_market_program.to_account_info(),
                sooth_market::cpi::accounts::TransferFeeToMarketPoolFromBook {
                    market: accounts.market.to_account_info(),
                    market_vault: accounts.market_usdc_vault.to_account_info(),
                    market_fee_pool: accounts.market_fee_pool.to_account_info(),
                    vault_authority: accounts.vault_authority.to_account_info(),
                    instruction_sysvar: accounts.instruction_sysvar.to_account_info(),
                    token_program: accounts.token_program.to_account_info(),
                },
            ),
            amount,
        )?;
        accounts.market_book.pending_fees = 0;
    }

    Ok(())
}

impl<'a, 'info> BuyAccounts<'a, 'info> {
    fn rent_account_info(&self) -> AccountInfo<'info> {
        self.rent.to_account_info()
    }
}
