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
use anchor_lang::{emit_cpi, event_cpi};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::book::account::load_book;
use crate::book::arena::{SIDE_ASK, SIDE_BID};
use crate::constants::BOOK_TOKEN_MINT;
use crate::error::SoothCoreError;
use crate::events::{BookFill, BookFilled, BookOrderPlaced, BOOK_EVENT_VERSION};
use crate::state::{require_not_paused, Market, ProtocolConfig};

/// `#[event_cpi]` adds `event_authority` + `program` and lets `emit_cpi!`
/// self-invoke, putting the payload in an inner instruction instead of a
/// program log.
///
/// This is what `sooth_log` exists to do. It was built on the belief that a
/// program cannot CPI into itself — but Solana permits **direct self
/// recursion**, which is exactly the mechanism Anchor uses here. So the whole
/// second program, its `declare_id` mismatch, and its deploy are avoidable.
/// The legacy `buy` path still uses it; deleting it is gated on that going.
#[event_cpi]
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
        address = market.vault_book @ SoothCoreError::VaultAuthorityMismatch,
        constraint = vault_book.mint == BOOK_TOKEN_MINT @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub vault_book: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault_book.mint, token::authority = taker)]
    pub taker_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"fee_pool_book", market.market_id.as_ref()],
        bump,
        token::mint = vault_book.mint,
    )]
    pub fee_pool_book: Box<Account<'info, TokenAccount>>,

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

    // Trading stops when the market does.
    //
    // `book_place` checked only the pause flag, so orders matched on a LOCKED
    // or SETTLED market — one whose outcome is already known. That is free
    // money against anyone with a stale resting order: once YES has won, buy
    // YES from them at any price below 1.00 and redeem it for the full dollar.
    // The maker did nothing wrong except fail to cancel in time.
    //
    // Every other trading path already gates on this (`trade_positions`,
    // `sell_positions` both require `is_open`); the book was the gap.
    // `book_cancel` stays ungated on purpose — a maker must always be able to
    // get out, and after settlement that is the only way to recover escrow.
    require!(
        ctx.accounts.market.is_open(),
        SoothCoreError::MarketNotOpen
    );

    // The book opens at graduation, and not before.
    //
    // This was a UI convention until now: the program accepted orders on an
    // ungraduated market and only the front end declined to show the panel.
    // A market's incubation happens on the AMM — that is what graduation
    // measures and what the creator's subsidy pays for — so a book that trades
    // alongside it splits liquidity out of the venue being incubated.
    //
    // Read from `Market`, not `AmmState`: this instruction already loads the
    // former and does not load the latter, so checking the real flag would
    // cost an account and 32 bytes on every order. See `Market::book_enabled`.
    require!(
        ctx.accounts.market.book_enabled,
        SoothCoreError::NotGraduated
    );

    require!(
        side == SIDE_BID || side == SIDE_ASK,
        SoothCoreError::InvalidOutcome
    );

    // The fee rate comes from config, never from the caller.
    let fee_bps = ctx.accounts.protocol_config.book_fee_bps;
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
                    to: ctx.accounts.vault_book.to_account_info(),
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
                    from: ctx.accounts.vault_book.to_account_info(),
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
                    from: ctx.accounts.vault_book.to_account_info(),
                    to: ctx.accounts.fee_pool_book.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                seeds,
            ),
            result.fee,
        )?;
    }

    let ts = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();

    if !result.filled_orders.is_empty() {
        emit_cpi!(BookFilled {
            version: BOOK_EVENT_VERSION,
            market: market_key,
            taker,
            taker_side: side,
            fills: result
                .filled_orders
                .iter()
                .map(|f| BookFill {
                    maker: f.maker,
                    maker_seq: f.maker_seq,
                    price_tick: f.price_tick,
                    amount: f.amount,
                })
                .collect(),
            fee: result.fee,
            ts,
        });
    }

    if result.resting > 0 {
        emit_cpi!(BookOrderPlaced {
            version: BOOK_EVENT_VERSION,
            market: market_key,
            // `place` assigns the resting order the next sequence, so the id
            // is the value the counter held before the write.
            seq: result.resting_seq,
            trader: taker,
            side,
            price_tick: limit_tick,
            amount: result.resting,
            ts,
        });
    }

    // The caller's own resting orders were cancelled to make way for this one,
    // and their escrow refunded to seat credit. Logged so a client can tell
    // the trader which of their orders went, rather than leaving them to
    // notice an order missing.
    if result.self_trade_cancelled > 0 {
        msg!(
            "self-trade prevention: cancelled {} of your own resting shares (refunded)",
            result.self_trade_cancelled,
        );
    }

    Ok(())
}
