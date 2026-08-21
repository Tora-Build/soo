//! `book_init` and `book_grow` — create the per-market book and extend it.
//!
//! Split into two instructions because Solana caps `realloc` at
//! [`MAX_PERMITTED_DATA_INCREASE`] (10,240 bytes) **per instruction**, measured
//! from the account's length at instruction entry. At 64 bytes per block that
//! is 160 blocks a call, so reaching [`MAX_ORDERS`] from empty takes several
//! calls. A single `init` that tried to allocate the maximum would simply
//! fail.
//!
//! The account is created by hand rather than with Anchor's `init` because it
//! is loaded by raw cast — there is no `#[account]` type for Anchor to size or
//! deserialize, and its length changes over the market's life.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::book::account::{
    book_space, capacity_for, grow_target, init_book, MAX_PERMITTED_DATA_INCREASE,
};
use crate::book::arena::MAX_ORDERS;
use crate::error::SoothCoreError;
use crate::state::Market;

#[derive(Accounts)]
pub struct BookInit<'info> {
    /// CHECK: created here; seeds bind it to the market and the handler writes
    /// the discriminator.
    #[account(mut, seeds = [b"book", market.market_id.as_ref()], bump)]
    pub book: UncheckedAccount<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn init_handler(ctx: Context<BookInit>, initial_capacity: u16) -> Result<()> {
    let capacity = (initial_capacity as usize).min(MAX_ORDERS as usize);
    let space = book_space(capacity);
    require!(
        space <= MAX_PERMITTED_DATA_INCREASE,
        SoothCoreError::BookCapacityTooLarge
    );

    let market_id = ctx.accounts.market.market_id;
    let bump = ctx.bumps.book;
    let seeds: &[&[&[u8]]] = &[&[b"book", market_id.as_ref(), &[bump]]];

    let rent = Rent::get()?;
    system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::CreateAccount {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.book.to_account_info(),
            },
            seeds,
        ),
        rent.minimum_balance(space),
        space as u64,
        &crate::ID,
    )?;

    let info = ctx.accounts.book.to_account_info();
    let mut data = info.try_borrow_mut_data()?;
    init_book(&mut data, ctx.accounts.market.key(), bump)
        .map_err(|_| error!(SoothCoreError::InvalidBookAccount))?;

    msg!("book init capacity={} space={}", capacity, space);
    Ok(())
}

#[derive(Accounts)]
pub struct BookGrow<'info> {
    /// CHECK: existing book; `grow_target` and the seeds bind it.
    #[account(mut, seeds = [b"book", market.market_id.as_ref()], bump)]
    pub book: UncheckedAccount<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Extend the book toward `wanted_capacity`, one realloc step at a time.
///
/// Permissionless: growing the book only ever costs the caller rent, and
/// gating it would let a market wedge at capacity because the one authority
/// that could extend it was unavailable. The order cap plus per-order escrow is
/// what bounds grief-growth, not an authority check.
pub fn grow_handler(ctx: Context<BookGrow>, wanted_capacity: u16) -> Result<()> {
    let info = ctx.accounts.book.to_account_info();
    let current = info.data_len();

    let Some(target) = grow_target(current, wanted_capacity as usize) else {
        // Already big enough, or already at the cap. Not an error — a client
        // that over-asks should be a no-op, not a failed transaction.
        msg!("book already at capacity {}", capacity_for(current));
        return Ok(());
    };

    // Top up rent for the new bytes before reallocating, or the account falls
    // below the exemption threshold and is reaped.
    let rent = Rent::get()?;
    let needed = rent.minimum_balance(target);
    let have = info.lamports();
    if needed > have {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: info.clone(),
                },
            ),
            needed - have,
        )?;
    }

    info.realloc(target, true)?;
    msg!(
        "book grew {} -> {} bytes (capacity {})",
        current,
        target,
        capacity_for(target)
    );
    Ok(())
}
