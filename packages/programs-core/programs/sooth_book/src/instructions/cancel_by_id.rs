use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use sooth_market::program::SoothMarket;
use sooth_market::state::Market;

use crate::error::CoreError;
use crate::events::OrderCancelled;
use crate::instructions::cancel::{refund_order, CancelAccounts};
use crate::math::{MAX_TICK, MIN_TICK};
use crate::state::{require_order_id_matches, BookSide, MarketBook};

#[derive(Accounts)]
#[instruction(_order_id: u64, side: u8, tick: u16)]
pub struct CancelByIdOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [b"market_book", market.market_id.as_ref()],
        bump,
        constraint = market_book.market == market.key() @ CoreError::OrderIdSeedMismatch,
    )]
    pub market_book: Box<Account<'info, MarketBook>>,

    #[account(
        mut,
        seeds = [b"book_side", market.market_id.as_ref(), &[side], &tick.to_le_bytes()],
        bump,
        has_one = market @ CoreError::OrderIdSeedMismatch,
    )]
    pub book_side: Box<Account<'info, BookSide>>,

    /// CHECK: derived via sooth_market seeds; signs vault outflows there.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
        seeds::program = sooth_market::ID,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault @ CoreError::BaseMintDrift,
    )]
    pub market_usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = market_usdc_vault.mint,
        token::authority = user,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA seed-bound under sooth_market; the sooth_market CPI owns it.
    #[account(
        mut,
        seeds = [
            b"orderbook_position",
            market.market_id.as_ref(),
            user.key().as_ref()
        ],
        bump,
        seeds::program = sooth_market::ID,
    )]
    pub user_orderbook_position: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
    pub sooth_market_program: Program<'info, SoothMarket>,

    /// CHECK: address-pinned and forwarded to sooth_market CPI gates.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn cancel_by_id_handler(
    ctx: Context<CancelByIdOrder>,
    order_id: u64,
    side: u8,
    tick: u16,
) -> Result<()> {
    require!(side <= 1, CoreError::InvalidOrderId);
    require!(
        (MIN_TICK..=MAX_TICK).contains(&tick),
        CoreError::InvalidTick
    );
    require_order_id_matches(order_id, side, tick)?;
    require!(
        ctx.accounts.book_side.side == side && ctx.accounts.book_side.tick == tick,
        CoreError::OrderIdSeedMismatch
    );

    let signer = ctx.accounts.user.key();
    let idx = ctx
        .accounts
        .book_side
        .orders
        .iter()
        .position(|o| o.id == order_id && o.amount > 0 && o.maker == signer)
        .ok_or(error!(CoreError::NoCancellableOrder))?;
    let order = ctx.accounts.book_side.orders[idx].clone();

    let accounts = CancelAccounts {
        user: &ctx.accounts.user,
        market: ctx.accounts.market.as_ref(),
        vault_authority: &ctx.accounts.vault_authority,
        market_usdc_vault: ctx.accounts.market_usdc_vault.as_ref(),
        user_usdc_ata: ctx.accounts.user_usdc_ata.as_ref(),
        user_orderbook_position: &ctx.accounts.user_orderbook_position,
        system_program: &ctx.accounts.system_program,
        token_program: &ctx.accounts.token_program,
        rent: &ctx.accounts.rent,
        sooth_market_program: &ctx.accounts.sooth_market_program,
        instruction_sysvar: &ctx.accounts.instruction_sysvar,
    };
    refund_order(&accounts, side, tick, &order)?;

    ctx.accounts.book_side.orders[idx].amount = 0;
    let head = ctx.accounts.book_side.head_index as usize;
    if ctx.accounts.book_side.orders[head..]
        .iter()
        .all(|order| order.amount == 0)
    {
        ctx.accounts.market_book.bitmap_mut(side).clear_bit(tick);
    }

    emit!(OrderCancelled {
        market: ctx.accounts.market.key(),
        side,
        tick,
        maker: signer,
        order_id,
    });
    Ok(())
}
