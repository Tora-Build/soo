//! `cancel_by_id` — cancel a specific order by its 64-bit order ID.

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::error::SoothCoreError;
use crate::events::OrderCancelled;
use crate::instructions::cancel::refund_order;
use crate::math::{MAX_TICK, MIN_TICK};
use crate::state::{require_order_id_matches, BookSide, Market, MarketBook};

#[derive(Accounts)]
#[instruction(_order_id: u64, side: u8, tick: u16)]
pub struct CancelByIdOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [b"market_book", market.market_id.as_ref()],
        bump,
        constraint = market_book.market == market.key() @ SoothCoreError::OrderIdSeedMismatch,
    )]
    pub market_book: Box<Account<'info, MarketBook>>,

    #[account(
        mut,
        seeds = [b"book_side", market.market_id.as_ref(), &[side], &tick.to_le_bytes()],
        bump,
        has_one = market @ SoothCoreError::OrderIdSeedMismatch,
    )]
    pub book_side: Box<Account<'info, BookSide>>,

    /// CHECK: derived via seeds; signs vault outflows.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault @ SoothCoreError::BaseMintDrift,
    )]
    pub market_usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = market_usdc_vault.mint,
        token::authority = user,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA seed-bound under crate::ID.
    #[account(
        mut,
        seeds = [
            b"orderbook_position",
            market.market_id.as_ref(),
            user.key().as_ref()
        ],
        bump,
    )]
    pub user_orderbook_position: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<CancelByIdOrder>, order_id: u64, side: u8, tick: u16) -> Result<()> {
    require!(side <= 1, SoothCoreError::InvalidOrderId);
    require!(
        (MIN_TICK..=MAX_TICK).contains(&tick),
        SoothCoreError::InvalidTick
    );
    require_order_id_matches(order_id, side, tick)?;
    require!(
        ctx.accounts.book_side.side == side && ctx.accounts.book_side.tick == tick,
        SoothCoreError::OrderIdSeedMismatch
    );

    let signer = ctx.accounts.user.key();
    let idx = ctx
        .accounts
        .book_side
        .orders
        .iter()
        .position(|o| o.id == order_id && o.amount > 0 && o.maker == signer)
        .ok_or(error!(SoothCoreError::NoCancellableOrder))?;
    let order = ctx.accounts.book_side.orders[idx].clone();

    refund_order(
        &ctx.accounts.user,
        ctx.accounts.market.as_ref(),
        &ctx.accounts.vault_authority,
        ctx.accounts.market_usdc_vault.as_ref(),
        ctx.accounts.user_usdc_ata.as_ref(),
        &ctx.accounts.user_orderbook_position,
        &ctx.accounts.system_program,
        &ctx.accounts.token_program,
        &ctx.accounts.rent,
        side,
        tick,
        &order,
    )?;

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
        remaining: order.amount,
    });
    Ok(())
}
