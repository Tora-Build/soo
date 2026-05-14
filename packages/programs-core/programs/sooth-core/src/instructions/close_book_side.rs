//! `close_book_side` — permissionlessly close a fully-drained `BookSide`.
//!
//! Adapted from `sooth_book::close_book_side`. `seeds::program` removed from
//! `market`. `market` typed from this crate. Logic unchanged.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::state::{BookSide, Market, MarketBook};

#[derive(Accounts)]
pub struct CloseBookSide<'info> {
    #[account(mut)]
    pub closer: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        seeds = [b"market_book", market.market_id.as_ref()],
        bump,
        constraint = market_book.market == market.key() @ SoothCoreError::OrderIdSeedMismatch,
    )]
    pub market_book: Box<Account<'info, MarketBook>>,

    #[account(
        mut,
        close = closer,
        seeds = [
            b"book_side",
            market.market_id.as_ref(),
            &[book_side.side],
            &book_side.tick.to_le_bytes()
        ],
        bump,
        has_one = market @ SoothCoreError::OrderIdSeedMismatch,
    )]
    pub book_side: Box<Account<'info, BookSide>>,
}

pub fn handler(ctx: Context<CloseBookSide>) -> Result<()> {
    let book = &ctx.accounts.market_book;
    let book_side = &ctx.accounts.book_side;
    require!(
        book_side.head_index as usize == book_side.orders.len(),
        SoothCoreError::BookSideNotDrained
    );
    require!(
        !book.bitmap(book_side.side).is_set(book_side.tick),
        SoothCoreError::BookSideNotDrained
    );
    Ok(())
}
