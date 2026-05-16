//! `compact_book_side` — trim trailing zero-amount orders from a `BookSide`.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::state::{BookSide, Market};

#[derive(Accounts)]
pub struct CompactBookSide<'info> {
    pub cranker: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
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

pub fn handler(ctx: Context<CompactBookSide>, max_drops: u8) -> Result<()> {
    require!(max_drops <= 16, SoothCoreError::CompactBoundExceeded);

    let book_side = &mut ctx.accounts.book_side;
    let mut dropped = 0u8;
    while dropped < max_drops && book_side.orders.last().map_or(false, |o| o.amount == 0) {
        book_side.orders.pop();
        dropped += 1;
    }

    let new_space = BookSide::space_for(book_side.orders.len());
    let info = book_side.to_account_info();
    if info.data_len() > new_space {
        info.realloc(new_space, false)?;
    }
    Ok(())
}
