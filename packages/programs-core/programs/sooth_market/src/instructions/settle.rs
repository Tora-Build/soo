//! `settle` — finalize a Locked market with the adjudicator's winning outcome.
//!
//! EVM analogue: `TruthMarket.attest` + `TruthMarket.settle` collapsed
//! (`TruthMarket.sol:112-131`). On Solana we don't run an
//! ATTESTED-with-veto-window phase in v1 — the adjudicator program is
//! responsible for any dispute logic before calling `settle`, and the on-
//! market state goes Locked → Settled in a single ix.
//!
//! ## Authority gating
//!
//! Same `todo!()` shape as `lock_for_resolution`. The state mutation is real;
//! the adjudicator-CPI auth check is left for `sooth_adjudicator` (architecture
//! §4.4).

use anchor_lang::prelude::*;

use crate::error::SoothMarketError;
use crate::events::MarketSettled;
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::{Market, MarketLifecycle};

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// CHECK: see `lock_for_resolution::handler` notes — same `todo!()`
    /// shape; the auth check is unimplemented pending `sooth_adjudicator`.
    pub adjudicator: Signer<'info>,
}

pub fn handler(ctx: Context<Settle>, winning_outcome: u8) -> Result<()> {
    require!(
        winning_outcome == OUTCOME_NO
            || winning_outcome == OUTCOME_YES
            || winning_outcome == OUTCOME_INVALID,
        SoothMarketError::InvalidOutcome
    );

    // ── Auth — STUB ──────────────────────────────────────────────────────
    //
    // TODO(architecture §4.4): replace with the adjudicator-CPI auth check
    // once `sooth_adjudicator` is wired.
    if ctx.accounts.market.adjudicator == Pubkey::default() {
        todo!("adjudicator-CPI auth check not yet wired; see architecture §4.4");
    }
    require_keys_eq!(
        ctx.accounts.adjudicator.key(),
        ctx.accounts.market.adjudicator,
        SoothMarketError::NotAdjudicator
    );

    let market = &mut ctx.accounts.market;
    require!(
        market.lifecycle.can_transition_to(MarketLifecycle::Settled),
        SoothMarketError::InvalidLifecycleTransition
    );
    market.lifecycle = MarketLifecycle::Settled;
    market.winning_outcome = winning_outcome;

    let now = Clock::get()?.unix_timestamp;
    emit!(MarketSettled {
        market: market.key(),
        winning_outcome,
        ts: now,
    });

    Ok(())
}
