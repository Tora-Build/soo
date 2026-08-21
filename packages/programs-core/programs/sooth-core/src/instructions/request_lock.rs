//! `request_lock` — the PERMISSIONLESS half of Open → Locked.
//!
//! ## Two instructions, two roles
//!
//! Locking a market is reachable two ways, and they are deliberately not the
//! same instruction:
//!
//!   - [`lock_for_resolution`](super::lock_for_resolution) is the
//!     **adjudicator's** lock. It fires at ANY time, deadline or not, because
//!     a Sooth market asks "will X happen BY time T". Once X has happened the
//!     question is answered, and continuing to trade a settled fact is free
//!     money against anyone with a stale order. Early locking is therefore the
//!     trust model, not an oversight: the adjudicator is trusted to say when
//!     the answer is known, and `attest` + the veto window + `dispute` are
//!     what bound that trust.
//!
//!   - `request_lock` is **anyone's** lock, and only once the advertised
//!     deadline has passed. At that instant every trading path already refuses
//!     — `trade_positions` and `sell_positions` require `now < deadline`, and
//!     so does `book_place` — so the transition records a fact that is already
//!     true, and no signer is privileged enough to be worth requiring.
//!
//! ## Why it is permissionless
//!
//! `settle` requires `Locked`. If the lock were adjudicator-only, a lost key
//! or a departed operator would pin a market in `Open` forever, and with it
//! every AMM position, book seat, LP stake and escrowed sell in it — none of
//! which has a payout path that does not run through settlement. Making the
//! post-deadline transition permissionless removes one key from that critical
//! path.
//!
//! It does not remove the other: `settle` still needs an attested outcome, so
//! an adjudicator who vanishes before attesting still strands the market. This
//! instruction narrows the failure, it does not eliminate it.
//!
//! ## What a post-deadline lock can and cannot do to someone
//!
//! Locking cannot grief a trader: after the deadline every venue has already
//! stopped accepting orders, and the two paths that must stay open to an exit
//! — `book_cancel` and `claim_unlocked` — are gated on neither the lifecycle
//! nor the deadline.
//!
//! It does close one door on the CREATOR: `dismiss_market` requires an `Open`
//! market, so a permissionless lock ends the option to dismiss and refund at
//! cost, leaving resolution as the only exit. That is the intended ordering —
//! after the deadline the question's window has closed and holders are owed an
//! outcome, not a rewind — and the creator keeps the whole trial window before
//! the deadline to dismiss. The same door was already closable at will by the
//! adjudicator through `lock_for_resolution`.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::MarketLocked;
use crate::state::{AdjudicatorEntry, Market, MarketLifecycle, ADJUDICATOR_ENTRY_SEED};

#[derive(Accounts)]
pub struct RequestLock<'info> {
    /// Read-only, and required even though no signature is checked against
    /// it: a market with no registered adjudicator can never be attested and
    /// so can never settle, and locking it would only freeze it sooner.
    #[account(
        seeds = [ADJUDICATOR_ENTRY_SEED, market.key().as_ref()],
        bump = adjudicator_entry.bump,
        constraint = adjudicator_entry.market == market.key()
            @ SoothCoreError::AdjudicatorMarketMismatch,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// Any signer. Present so the transaction has a fee payer; the account
    /// list is unchanged from the adjudicator-only version so callers built
    /// against the old IDL keep working.
    pub authority: Signer<'info>,
}

/// The full precondition for a permissionless lock: an `Open` market whose
/// advertised deadline has passed.
///
/// A dismissed market is not `Open`, so it is refused here — dismissal and
/// resolution are the two terminal paths and a lock would put a refunding
/// market on the settling one.
fn assert_lockable_after_deadline(market: &Market, now: i64) -> Result<()> {
    require!(market.is_open(), SoothCoreError::MarketNotOpen);
    require!(
        market.lifecycle.can_transition_to(MarketLifecycle::Locked),
        SoothCoreError::InvalidLifecycleTransition
    );
    require!(now >= market.deadline, SoothCoreError::TradingNotClosed);
    Ok(())
}

pub fn handler(ctx: Context<RequestLock>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &mut ctx.accounts.market;

    assert_lockable_after_deadline(market, now)?;

    market.lifecycle = MarketLifecycle::Locked;

    // Same event as the adjudicator's lock: downstream readers care that the
    // market stopped, not which door it went through.
    emit!(MarketLocked {
        market: market.key(),
        ts: now,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::market::market_fixture;

    #[test]
    fn anyone_may_lock_once_the_deadline_has_passed() {
        // The liveness property: no key appears in this guard, so a market
        // reaches `Locked` — and therefore `settle` — without the adjudicator.
        let market = market_fixture(MarketLifecycle::Open);
        assert!(assert_lockable_after_deadline(&market, market.deadline).is_ok());
    }

    #[test]
    fn the_deadline_boundary_is_inclusive() {
        // Trading refuses AT the deadline (`now < deadline` on every venue),
        // so locking must be permitted at exactly that instant or there is a
        // one-second window belonging to neither.
        let market = market_fixture(MarketLifecycle::Open);
        assert!(assert_lockable_after_deadline(&market, market.deadline - 1).is_err());
        assert!(assert_lockable_after_deadline(&market, market.deadline).is_ok());
    }

    #[test]
    fn an_early_lock_is_the_adjudicators_alone() {
        // This is the role split: `lock_for_resolution` may fire before the
        // deadline, this may not. Without the deadline the permissionless
        // path would be a public halt button on a live market.
        let market = market_fixture(MarketLifecycle::Open);
        assert!(assert_lockable_after_deadline(&market, market.deadline - 60).is_err());
    }

    #[test]
    fn a_locked_market_does_not_lock_twice() {
        let market = market_fixture(MarketLifecycle::Locked);
        assert!(assert_lockable_after_deadline(&market, market.deadline + 1).is_err());
    }

    #[test]
    fn a_settled_market_cannot_be_reopened_into_a_lock() {
        let market = market_fixture(MarketLifecycle::Settled);
        assert!(assert_lockable_after_deadline(&market, market.deadline + 1).is_err());
    }

    #[test]
    fn a_dismissed_market_is_not_lockable() {
        // Dismissal refunds at cost; locking it would route it toward a
        // settlement payout out of the same vault.
        let mut market = market_fixture(MarketLifecycle::Open);
        market.is_dismissed = true;
        assert!(assert_lockable_after_deadline(&market, market.deadline + 1).is_err());
    }
}
