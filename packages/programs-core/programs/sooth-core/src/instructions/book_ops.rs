//! `book_cancel` and `book_withdraw` — the rest of the book instruction set.
//!
//! Both are deliberately tiny. Cancel refunds an order's escrow to the owner's
//! **seat credit**, not to their wallet, and withdraw is the single place credit
//! becomes USDC. That split is what keeps a fill free of token movement: a
//! transaction touches the vault at most twice regardless of how many orders it
//! crosses or cancels.

use anchor_lang::prelude::*;
use anchor_lang::{emit_cpi, event_cpi};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::book::account::load_book;
use crate::constants::BOOK_TOKEN_MINT;
use crate::error::SoothCoreError;
use crate::events::{BookOrderCancelled, BOOK_EVENT_VERSION};
use crate::state::Market;

#[event_cpi]
#[derive(Accounts)]
pub struct BookCancel<'info> {
    /// CHECK: raw zero-copy book; `load_book` verifies the discriminator.
    #[account(mut, seeds = [b"book", market.market_id.as_ref()], bump)]
    pub book: UncheckedAccount<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    pub owner: Signer<'info>,
}

/// Cancel a resting order. The refund lands in the owner's seat credit; call
/// `book_withdraw` to move it to a wallet.
///
/// Not gated on `require_not_paused`: a maker
/// must always be able to pull a resting order, or a pause strands their
/// collateral in the book.
pub fn cancel_handler(ctx: Context<BookCancel>, order_seq: u64) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    let info = ctx.accounts.book.to_account_info();
    let mut data = info.try_borrow_mut_data()?;
    let mut book = load_book(&mut data).map_err(|_| error!(SoothCoreError::InvalidBookAccount))?;

    let refund = book
        .cancel(owner, order_seq)
        .map_err(|_| error!(SoothCoreError::NoCancellableOrder))?;

    drop(data);
    emit_cpi!(BookOrderCancelled {
        version: BOOK_EVENT_VERSION,
        market: ctx.accounts.market.key(),
        seq: order_seq,
        trader: owner,
        refund,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct BookWithdraw<'info> {
    /// CHECK: raw zero-copy book; `load_book` verifies the discriminator.
    #[account(mut, seeds = [b"book", market.market_id.as_ref()], bump)]
    pub book: UncheckedAccount<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: derived via seeds; signs the vault outflow.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault_book @ SoothCoreError::VaultAuthorityMismatch,
        constraint = vault_book.mint == BOOK_TOKEN_MINT @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub vault_book: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault_book.mint, token::authority = user)]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

/// Move a trader's accumulated seat credit into their wallet.
///
/// An exit path, so like the other exits it is ungated by the pause flag — a
/// pause that traps user funds is its own failure mode.
pub fn withdraw_handler(ctx: Context<BookWithdraw>) -> Result<()> {
    let user = ctx.accounts.user.key();
    let amount = {
        let info = ctx.accounts.book.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        let mut book =
            load_book(&mut data).map_err(|_| error!(SoothCoreError::InvalidBookAccount))?;
        // Zeroed BEFORE the transfer, inside its own scope so the account
        // borrow is released. A re-entrant call would find nothing to take.
        book.take_credit(user)
            .map_err(|_| error!(SoothCoreError::InvalidBookAccount))?
    };

    if amount > 0 {
        let market_id = ctx.accounts.market.market_id;
        let bump = ctx.accounts.market.vault_authority_bump;
        let seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_book.to_account_info(),
                    to: ctx.accounts.user_usdc_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                seeds,
            ),
            amount,
        )?;
    }
    msg!("withdrew {}", amount);
    Ok(())
}
