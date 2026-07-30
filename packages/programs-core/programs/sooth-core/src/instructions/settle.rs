//! `settle` — finalize an attested market once its veto window has closed.
//!
//! Permissionless, and takes no outcome argument. Both are deliberate:
//!
//!   - **Permissionless.** The outcome is already fixed on the
//!     `AdjudicatorEntry` by `attest_outcome`; settle only moves the
//!     lifecycle. Requiring the adjudicator to come back would make
//!     finalization — and therefore every redemption — depend on one key
//!     staying live. Mirrors EVM, where `settle(address market)` is callable
//!     by anyone after `vetoEndsAt`.
//!
//!   - **No `winning_outcome` argument.** It is read from the entry. The
//!     previous signature let the authority settle an outcome that differed
//!     from the one attested, which would have made the veto window
//!     meaningless: dispute the attestation all you like, settle could pass
//!     something else. The attested value is now the only thing that can be
//!     finalized.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::MarketSettled;
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::{
    AdjudicatorEntry, Market, MarketLifecycle, ProtocolConfig, ADJUDICATOR_ENTRY_SEED,
};

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// Per-market adjudicator record. Used to authenticate the caller.
    #[account(
        seeds = [ADJUDICATOR_ENTRY_SEED, market.key().as_ref()],
        bump = adjudicator_entry.bump,
        constraint = adjudicator_entry.market == market.key()
            @ SoothCoreError::AdjudicatorMarketMismatch,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Whoever cranks the settle. Unconstrained by design — see module docs.
    /// Present only so the transaction has a signer to pay fees.
    pub cranker: Signer<'info>,
}

pub fn handler(ctx: Context<Settle>) -> Result<()> {
    let entry = &ctx.accounts.adjudicator_entry;

    let winning_outcome = entry
        .attested_outcome
        .ok_or(error!(SoothCoreError::NotYetAttested))?;
    let attested_at = entry
        .attested_at
        .ok_or(error!(SoothCoreError::NotYetAttested))?;

    // Defence in depth: the outcome was validated at attest/dispute time, but
    // this is the value that becomes permanent, so re-check it rather than
    // trusting stored state.
    require!(
        winning_outcome == OUTCOME_NO
            || winning_outcome == OUTCOME_YES
            || winning_outcome == OUTCOME_INVALID,
        SoothCoreError::InvalidOutcome
    );

    let now = Clock::get()?.unix_timestamp;
    let veto_ends_at = attested_at
        .checked_add(ctx.accounts.protocol_config.veto_period_secs)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    require!(now >= veto_ends_at, SoothCoreError::VetoWindowOpen);

    let market = &mut ctx.accounts.market;
    require!(
        market.lifecycle.can_transition_to(MarketLifecycle::Settled),
        SoothCoreError::InvalidLifecycleTransition
    );
    market.lifecycle = MarketLifecycle::Settled;
    market.winning_outcome = winning_outcome;

    emit!(MarketSettled {
        market: market.key(),
        winning_outcome,
        ts: now,
    });

    Ok(())
}
