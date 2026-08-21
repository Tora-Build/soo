//! `lock_for_resolution` — the ADJUDICATOR's Open → Locked, callable at any
//! time.
//!
//! ## Early locking is the trust model
//!
//! A Sooth market asks "will X happen BY time T", not "at time T". So when X
//! happens early the question is already answered, and every further trade is
//! free money taken from whoever has not noticed yet. The adjudicator may
//! therefore freeze trading the moment the answer is known — before the
//! deadline, deliberately — and attest immediately.
//!
//! That is authority, and it is bounded rather than absolute: locking decides
//! only WHEN trading stops. The outcome still goes through `attest_outcome`,
//! sits out `ProtocolConfig.veto_period_secs` where `dispute` can override it,
//! and only then does the permissionless `settle` make it final.
//!
//! ## The other door
//!
//! `request_lock` performs the same transition with no privileged signer, but
//! only once `market.deadline` has passed — by then every venue has already
//! stopped accepting orders on its own. The two are not redundant: this one is
//! trusted and early, that one is public and late, and the late one is what
//! keeps a market from sitting `Open` forever if this key is lost.
//!
//! Auth is via `AdjudicatorEntry` directly — the signer must be
//! `adjudicator_entry.authority`.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::MarketLocked;
use crate::state::{AdjudicatorEntry, Market, MarketLifecycle, ADJUDICATOR_ENTRY_SEED};

#[derive(Accounts)]
pub struct LockForResolution<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// Per-market adjudicator record. Bound to `market` via seed derivation.
    #[account(
        seeds = [ADJUDICATOR_ENTRY_SEED, market.key().as_ref()],
        bump = adjudicator_entry.bump,
        constraint = adjudicator_entry.market == market.key()
            @ SoothCoreError::AdjudicatorMarketMismatch,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    /// Authority that may request a lock. Must be `adjudicator_entry.authority`.
    pub authority: Signer<'info>,
}

/// The adjudicator's precondition: an `Open`, undismissed market. No clock
/// appears here — see the module docs for why an early lock is intended.
///
/// Dismissal is excluded because it is the other terminal path: a dismissed
/// market refunds at cost, and moving it toward settlement would point two
/// payout paths at one vault.
fn assert_lockable(market: &Market) -> Result<()> {
    require!(!market.is_dismissed, SoothCoreError::MarketDismissed);
    require!(
        market.lifecycle.can_transition_to(MarketLifecycle::Locked),
        SoothCoreError::InvalidLifecycleTransition
    );
    Ok(())
}

pub fn handler(ctx: Context<LockForResolution>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.adjudicator_entry.authority,
        SoothCoreError::NotAuthority
    );

    let market = &mut ctx.accounts.market;
    assert_lockable(market)?;
    market.lifecycle = MarketLifecycle::Locked;

    let now = Clock::get()?.unix_timestamp;
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
    fn the_adjudicator_may_lock_long_before_the_deadline() {
        // The intended behaviour, pinned: "will X happen BY T" is answerable
        // the moment X happens. No clock reaches this guard.
        let market = market_fixture(MarketLifecycle::Open);
        assert!(market.deadline > 0, "the fixture has a future deadline");
        assert!(assert_lockable(&market).is_ok());
    }

    #[test]
    fn locking_stays_one_way() {
        assert!(assert_lockable(&market_fixture(MarketLifecycle::Locked)).is_err());
        assert!(assert_lockable(&market_fixture(MarketLifecycle::Settled)).is_err());
    }

    #[test]
    fn a_dismissed_market_is_refused() {
        let mut market = market_fixture(MarketLifecycle::Open);
        market.is_dismissed = true;
        assert!(assert_lockable(&market).is_err());
    }
}
