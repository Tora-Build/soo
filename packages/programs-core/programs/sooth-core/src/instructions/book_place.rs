//! `book_place` — place an order on the book.
//!
//! See `docs/design/orderbook-redesign.md`.
//!
//! Account count is **flat, independent of how many orders the taker
//! crosses**: a per-fill account list would cap a crossing buy at 5 against
//! the 1232-byte packet limit.
//!
//! Token movement is **netted to one transfer per transaction**, not one per
//! fill. Fills credit `SeatNode::credit` inside the book; the taker's own
//! collateral in and out are accumulated across the whole match and settled
//! once at the end. That is Phoenix's seat model, and it is why the measured
//! marginal cost of a fill is ~821 CU.

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
/// No helper program is needed for this: Solana permits **direct self
/// recursion**, which is exactly the mechanism Anchor uses here.
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

/// Placement and matching are permitted strictly before the deadline. At the
/// deadline the book stops taking orders, whether or not the lock has landed.
fn assert_within_trading_window(now: i64, deadline: i64) -> Result<()> {
    require!(now < deadline, SoothCoreError::TradingClosed);
    Ok(())
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
    // Matching on a LOCKED or SETTLED market — one whose outcome is already
    // known — would be free money against anyone with a stale resting order:
    // once YES has won, buy YES from them at any price below 1.00 and redeem
    // it for the full dollar. Every trading path gates on this
    // (`trade_positions` and `sell_positions` both require `is_open`).
    // `book_cancel` stays ungated on purpose — a maker must always be able to
    // get out, and after settlement that is the only way to recover escrow.
    require!(ctx.accounts.market.is_open(), SoothCoreError::MarketNotOpen);

    // The book opens at graduation, and not before. Enforced on chain, not
    // by the front end declining to show the panel.
    //
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

    // Trading also stops at the advertised deadline, not merely whenever the
    // lock authority gets round to submitting the transition.
    //
    // The lifecycle check above is a check on someone else's transaction. The
    // gap between the deadline passing and `Locked` landing is time in which
    // the outcome may already be public while resting orders are still
    // fillable — the same free money, taken from makers who did exactly what
    // the market told them and left an order up until the cutoff.
    //
    // `book_cancel` is deliberately outside this gate: after the deadline,
    // cancelling is the only way a maker recovers escrow, so it must stay
    // available for as long as the order does.
    let now = Clock::get()?.unix_timestamp;
    assert_within_trading_window(now, ctx.accounts.market.deadline)?;

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

    let ts = now;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::market::market_fixture;
    use crate::state::MarketLifecycle;

    const DEADLINE: i64 = 1_000;

    #[test]
    fn an_order_places_before_the_deadline() {
        assert!(assert_within_trading_window(DEADLINE - 1, DEADLINE).is_ok());
    }

    #[test]
    fn an_order_is_refused_at_the_deadline() {
        // The boundary is exclusive: the advertised cutoff is the first
        // instant at which no order may be placed or filled.
        assert!(assert_within_trading_window(DEADLINE, DEADLINE).is_err());
    }

    #[test]
    fn a_resting_order_cannot_be_filled_after_the_deadline() {
        // A fill is a `book_place` that crosses, so the taker side of every
        // fill passes through this gate — including while the market is still
        // Open because the lock transition has not landed yet.
        let market = market_fixture(MarketLifecycle::Open);
        assert!(market.is_open());
        assert!(assert_within_trading_window(market.deadline + 60, market.deadline).is_err());
    }

    #[test]
    fn cancellation_is_not_caught_by_the_deadline_gate() {
        // `book_cancel` has its own handler in `book_ops.rs` and calls neither
        // this guard nor `is_open`; a maker's exit stays open indefinitely.
        // Pinned here because the gate above is what would otherwise trap
        // their escrow.
        let market = market_fixture(MarketLifecycle::Settled);
        let cancel_src = include_str!("book_ops.rs");
        let cancel_handler = cancel_src
            .split("pub fn cancel_handler")
            .nth(1)
            .expect("book_ops.rs defines cancel_handler");
        let body = &cancel_handler[..cancel_handler
            .find("\n}\n")
            .expect("cancel_handler has a body")];
        assert!(!body.contains("assert_within_trading_window"));
        assert!(!body.contains("is_open"));
        assert!(!body.contains("deadline"));
        assert!(!market.is_open());
    }
}
