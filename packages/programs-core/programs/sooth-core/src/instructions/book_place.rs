//! `book_place` — place an order on the redesigned book.
//!
//! Phase 3 of `docs/design/orderbook-redesign.md`.
//!
//! Account count is the headline: **flat, independent of how many orders the
//! taker crosses**. Today the equivalent is 14 fixed accounts plus 3 more per
//! fill, which caps a crossing buy at 5 against the 1232-byte packet limit.
//!
//! Token movement is **netted to one transfer per transaction**, not one per
//! fill. Fills credit `SeatNode::credit` inside the book; the taker's own
//! collateral in and out are accumulated across the whole match and settled
//! once at the end. That is Phoenix's seat model, and it is why the measured
//! marginal cost of a fill is ~821 CU rather than ~29,510.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::book::account::load_book;
use crate::book::arena::{SIDE_ASK, SIDE_BID};
use crate::constants::BASE_TOKEN_MINT;
use crate::error::SoothCoreError;
use crate::state::{require_not_paused, Market, ProtocolConfig};

#[derive(Accounts)]
pub struct BookPlace<'info> {
    /// CHECK: raw zero-copy book. `load_book` verifies the discriminator and
    /// length; the PDA seeds bind it to this market.
    #[account(mut, seeds = [b"book", market.market_id.as_ref()], bump)]
    pub book: UncheckedAccount<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: derived via seeds; signs vault outflows.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault @ SoothCoreError::VaultAuthorityMismatch,
        constraint = vault.mint == BASE_TOKEN_MINT @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault.mint, token::authority = taker)]
    pub taker_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"market_fee_pool", market.market_id.as_ref()],
        bump,
        token::mint = vault.mint,
    )]
    pub market_fee_pool: Box<Account<'info, TokenAccount>>,

    #[account(seeds = [b"protocol_config"], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    pub taker: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<BookPlace>,
    side: u8,
    limit_tick: u16,
    amount: u64,
    match_limit: u32,
    post_remainder: bool,
) -> Result<()> {
    require_not_paused(&ctx.accounts.protocol_config)?;
    require!(
        side == SIDE_BID || side == SIDE_ASK,
        SoothCoreError::InvalidOutcome
    );

    // The fee rate comes from config, never from the caller.
    let fee_bps = ctx.accounts.protocol_config.fee_bps;
    let taker = ctx.accounts.taker.key();

    // Scoped so the book's borrow is released before any CPI. A token program
    // invoke while holding a RefMut on an account we also pass would abort.
    let result = {
        let info = ctx.accounts.book.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        let mut book =
            load_book(&mut data).map_err(|_| error!(SoothCoreError::InvalidBookAccount))?;
        book.place(
            taker,
            side,
            limit_tick,
            amount,
            fee_bps,
            match_limit,
            post_remainder,
        )
        .map_err(|_| error!(SoothCoreError::MatchFailed))?
    };

    // ── Net the taker's collateral into at most one transfer each way ──────
    //
    // `collateral_in` is what the taker owes across every fill plus any
    // remainder they rested; `collateral_out` is what fills released by closing
    // existing exposure. Netting them means a 20-fill cross moves tokens twice,
    // not forty times — the property that makes the marginal cost of a fill
    // ~821 CU.
    let owed = result
        .taker_collateral_in
        .checked_add(result.fee)
        .ok_or(error!(SoothCoreError::MathOverflow))?;

    if owed > result.taker_collateral_out {
        let pull = owed - result.taker_collateral_out;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.taker_usdc_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            pull,
        )?;
    } else if result.taker_collateral_out > owed {
        let pay = result.taker_collateral_out - owed;
        let market_id = ctx.accounts.market.market_id;
        let bump = ctx.accounts.market.vault_authority_bump;
        let seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.taker_usdc_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                seeds,
            ),
            pay,
        )?;
    }

    // Fees leave the vault for the per-market pool in one move, not per fill.
    if result.fee > 0 {
        let market_id = ctx.accounts.market.market_id;
        let bump = ctx.accounts.market.vault_authority_bump;
        let seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.market_fee_pool.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                seeds,
            ),
            result.fee,
        )?;
    }

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
