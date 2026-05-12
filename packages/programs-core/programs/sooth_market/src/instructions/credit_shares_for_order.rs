use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::instruction_introspection::{
    require_sooth_book_cpi_parent, SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
    SOOTH_BOOK_BUY_YES_DISCRIMINATOR, SOOTH_BOOK_CANCEL_BY_ID_DISCRIMINATOR,
    SOOTH_BOOK_CANCEL_DISCRIMINATOR,
};
use crate::instructions::orderbook_common::{credit_shares, ensure_position_identity};
use crate::state::{Market, OrderbookPosition};

#[derive(Accounts)]
pub struct CreditSharesForOrder<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init_if_needed,
        payer = user,
        space = OrderbookPosition::SPACE,
        seeds = [b"orderbook_position", market.market_id.as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, OrderbookPosition>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,

    /// CHECK: address-pinned and parsed by the parent-ix gate.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<CreditSharesForOrder>, outcome: u8, amount: u128) -> Result<()> {
    require_sooth_book_cpi_parent(
        &ctx.accounts.instruction_sysvar,
        &[
            SOOTH_BOOK_BUY_YES_DISCRIMINATOR,
            SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
            SOOTH_BOOK_CANCEL_DISCRIMINATOR,
            SOOTH_BOOK_CANCEL_BY_ID_DISCRIMINATOR,
        ],
    )?;
    ensure_position_identity(
        &mut ctx.accounts.position,
        ctx.accounts.market.key(),
        ctx.accounts.user.key(),
    )?;
    credit_shares(&mut ctx.accounts.position, outcome, amount)
}
