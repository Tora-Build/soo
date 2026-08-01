//! `book_place` — place an order on the redesigned book.
//!
//! Phase 3 of `docs/design/orderbook-redesign.md`. Deliberately minimal: its
//! purpose right now is to make the match loop measurable on a real SVM, so it
//! carries no token movement. Collateral flows are computed and returned in the
//! log; wiring them to the vault is the next step.
//!
//! That omission does not affect the number this exists to produce. The claim
//! under test is the **marginal** cost of a fill, and in this design a fill
//! touches only blocks inside the book account: the maker's order, the maker's
//! seat, the taker's seat. Token movement is once per transaction (the taker's
//! net collateral) and once per withdrawal, never per fill — which is the whole
//! point of the seat model.
//!
//! Account count is the headline: `[book, taker]`, flat, **independent of how
//! many orders the taker crosses**. Today the equivalent is 14 fixed accounts
//! plus 3 more per fill.

use anchor_lang::prelude::*;

use crate::book::account::load_book;
use crate::book::arena::{SIDE_ASK, SIDE_BID};
use crate::error::SoothCoreError;

#[derive(Accounts)]
pub struct BookPlace<'info> {
    /// CHECK: raw zero-copy book. `load_book` verifies the discriminator and
    /// length; the market binding is checked in the handler.
    #[account(mut)]
    pub book: UncheckedAccount<'info>,
    pub taker: Signer<'info>,
}

pub fn handler(
    ctx: Context<BookPlace>,
    side: u8,
    limit_tick: u16,
    amount: u64,
    fee_bps: u16,
    match_limit: u32,
    post_remainder: bool,
) -> Result<()> {
    require!(
        side == SIDE_BID || side == SIDE_ASK,
        SoothCoreError::InvalidOutcome
    );

    let taker = ctx.accounts.taker.key();
    let info = ctx.accounts.book.to_account_info();
    let mut data = info.try_borrow_mut_data()?;

    let mut book = load_book(&mut data).map_err(|_| error!(SoothCoreError::InvalidBookAccount))?;
    let result = book
        .place(
            taker,
            side,
            limit_tick,
            amount,
            fee_bps,
            match_limit,
            post_remainder,
        )
        .map_err(|_| error!(SoothCoreError::MatchFailed))?;

    msg!(
        "fills={} filled={} resting={} in={} out={} fee={}",
        result.fills,
        result.filled,
        result.resting,
        result.taker_collateral_in,
        result.taker_collateral_out,
        result.fee
    );
    Ok(())
}
