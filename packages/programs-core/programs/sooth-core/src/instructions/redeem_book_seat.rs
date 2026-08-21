//! `redeem_book_seat` — pay out a book position after settlement.
//!
//! ## Why this exists
//!
//! This is the only instruction that turns a winning book **position** into
//! money. `book_withdraw` moves *credit* — USDC already released by a cancel
//! or by a fill that closed exposure — and pays out no position at all, so
//! without this a trader who bought YES on the book and watched the market
//! settle YES would have their winnings stranded.
//!
//! ## The payout rule
//!
//! A seat carries a SIGNED net — `> 0` long YES, `< 0` long NO — because
//! selling YES and buying NO are the same trade on a single price axis. So the
//! rule is just "does the winning side match the sign", and each winning share
//! redeems for exactly one unit.
//!
//! This can never overpay. Every matched share was backed by a full unit at
//! fill time: the bid leg and the ask leg of a fill sum to exactly 1.00, and
//! exactly one of the two holders is paid at settlement. Total out equals total
//! in, by construction rather than by accounting.
//!
//! `OUTCOME_INVALID` splits, matching `redeem_amm_position` so the two
//! ledgers cannot drift.
//!
//! ## Why resting orders are left alone
//!
//! Escrow behind a resting order is not a position; it is collateral for a
//! trade that has not happened. It comes back through `book_cancel`, which is
//! deliberately NOT gated on the market lifecycle so a maker is never trapped
//! after settlement. Draining it here would mean walking and unlinking the
//! trader's orders inside a settlement path, for no gain.
//!
//! ## Why the seat block is returned to the arena
//!
//! `take_settlement` zeroes both seat fields and then frees the block, so a
//! settled market's arena does not stay full of everyone who traded it. That is
//! only sound because this handler holds no cached block index — the matching
//! loop, which does, must never free a block.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::book::account::load_book;
use crate::constants::BOOK_TOKEN_MINT;
use crate::error::SoothCoreError;
use crate::events::Redeemed;
use crate::state::Market;

#[derive(Accounts)]
pub struct RedeemBookSeat<'info> {
    /// CHECK: raw zero-copy book. `load_book` verifies the discriminator and
    /// length; the PDA seeds bind it to this market.
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
        constraint = vault_book.mint == BOOK_TOKEN_MINT
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub vault_book: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault_book.mint, token::authority = user)]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RedeemBookSeat>) -> Result<()> {
    require!(
        ctx.accounts.market.is_settled(),
        SoothCoreError::MarketNotSettled
    );

    let user = ctx.accounts.user.key();
    let winning_outcome = ctx.accounts.market.winning_outcome;

    // Scoped so the book's borrow is released before the CPI — invoking the
    // token program while holding a RefMut on an account also passed to it
    // would abort.
    let payout = {
        let info = ctx.accounts.book.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        let mut book =
            load_book(&mut data).map_err(|_| error!(SoothCoreError::InvalidBookAccount))?;
        // Zeroed BEFORE the transfer, so a re-entrant call finds nothing left.
        book.take_settlement(user, winning_outcome)
            .map_err(|_| error!(SoothCoreError::InvalidBookAccount))?
    };

    if payout > 0 {
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
            payout,
        )?;
    }

    emit!(Redeemed {
        user,
        market: ctx.accounts.market.key(),
        outcome: winning_outcome,
        // No outcome TOKENS are involved: a book position lives in the seat's
        // signed net, not in an SPL balance, so there is nothing to burn.
        yes_burned: 0,
        no_burned: 0,
        usdc_paid: payout,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
