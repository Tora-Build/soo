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
//!   - **No `winning_outcome` argument.** It is read from the entry, so the
//!     attested value is the only thing that can be finalized. Accepting an
//!     outcome from the caller would make the veto window meaningless:
//!     dispute the attestation all you like, settle could pass something
//!     else.

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

    /// Per-market adjudicator record; supplies the attested outcome and
    /// timestamp.
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

/// Settlement is the terminal alternative to dismissal and excludes it.
///
/// A dismissed market refunds every AMM deposit at cost via `claim_refund`;
/// settling it as well would let the same deposit be paid twice out of the one
/// vault. `dismiss_market` holds the other half of this exclusion by refusing
/// to run on anything but an `Open` market.
fn assert_settleable(market: &Market) -> Result<()> {
    require!(!market.is_dismissed, SoothCoreError::MarketDismissed);
    require!(
        market.lifecycle.can_transition_to(MarketLifecycle::Settled),
        SoothCoreError::InvalidLifecycleTransition
    );
    Ok(())
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
    assert_settleable(market)?;
    market.lifecycle = MarketLifecycle::Settled;
    market.winning_outcome = winning_outcome;

    emit!(MarketSettled {
        market: market.key(),
        winning_outcome,
        ts: now,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::market::market_fixture;

    #[test]
    fn a_locked_market_settles() {
        let market = market_fixture(MarketLifecycle::Locked);
        assert!(assert_settleable(&market).is_ok());
    }

    #[test]
    fn settlement_is_refused_after_dismissal() {
        // The P0 invariant: dismiss → settle → redeem_amm_position would pay a
        // position that claim_refund can also refund, out of the same vault.
        let mut market = market_fixture(MarketLifecycle::Locked);
        market.is_dismissed = true;
        assert!(assert_settleable(&market).is_err());
    }

    #[test]
    fn a_dismissed_open_market_never_reaches_settlement() {
        let mut market = market_fixture(MarketLifecycle::Open);
        market.is_dismissed = true;
        assert!(assert_settleable(&market).is_err());
    }

    #[test]
    fn settlement_is_one_shot() {
        let market = market_fixture(MarketLifecycle::Settled);
        assert!(assert_settleable(&market).is_err());
    }

    #[test]
    fn an_open_market_cannot_skip_the_lock() {
        let market = market_fixture(MarketLifecycle::Open);
        assert!(assert_settleable(&market).is_err());
    }
}
