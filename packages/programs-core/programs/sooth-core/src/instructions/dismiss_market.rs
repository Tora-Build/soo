//! `dismiss_market` — the creator retires a market that never graduated.
//!
//! Dismissal and settlement are the two terminal outcomes of a market and they
//! exclude each other. A dismissed market refunds every AMM deposit at cost
//! (`claim_refund`); a settled one pays the winning side (`redeem_amm_position`).
//! Both draw on the same AMM vault, so a market that could take both paths
//! would pay the same deposit twice.
//!
//! The exclusion is enforced at both ends:
//!
//!   - here, dismissal is reachable only from a still-`Open` market, so it can
//!     never follow a lock or a settlement;
//!   - in `settle`, `Market.is_dismissed` blocks the reverse order.
//!
//! The flag is written on `Market` as well as `AmmState` because `settle` loads
//! only the former — see `Market::is_dismissed`.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::MarketDismissed;
use crate::state::{AmmState, Market};

#[derive(Accounts)]
pub struct DismissMarket<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        constraint = amm_state.market == market.key() @ SoothCoreError::AmmStateMarketMismatch,
    )]
    pub amm_state: Account<'info, AmmState>,

    #[account(constraint = creator.key() == market.creator @ SoothCoreError::Unauthorized)]
    pub creator: Signer<'info>,
}

pub fn handler(ctx: Context<DismissMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    assert_dismissible(&ctx.accounts.market, &ctx.accounts.amm_state, now)?;

    let market = &mut ctx.accounts.market;
    market.is_dismissed = true;

    let amm = &mut ctx.accounts.amm_state;
    amm.is_dismissed = true;

    emit!(MarketDismissed {
        market: amm.market,
        creator: ctx.accounts.creator.key(),
        dismissed_at: now,
    });
    Ok(())
}

/// The full precondition for dismissal: the trial window has run out, the
/// market never graduated, it has not been dismissed already, and it is still
/// `Open` — never locked, never settled.
fn assert_dismissible(market: &Market, amm: &AmmState, now: i64) -> Result<()> {
    require!(now >= amm.trial_end_at, SoothCoreError::TrialNotExpired);
    require!(!amm.is_graduated, SoothCoreError::AlreadyGraduated);
    require!(
        !amm.is_dismissed && !market.is_dismissed,
        SoothCoreError::AlreadyDismissed
    );
    // `is_open()` is false for a locked or settled market — and for an already
    // dismissed one, which the check above reports more precisely.
    require!(market.is_open(), SoothCoreError::MarketNotOpen);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::amm_state::amm_fixture;
    use crate::state::market::market_fixture;
    use crate::state::MarketLifecycle;

    const NOW: i64 = 2_000;

    #[test]
    fn an_open_untraded_market_is_dismissible_after_the_trial_window() {
        let market = market_fixture(MarketLifecycle::Open);
        let amm = amm_fixture();
        assert!(assert_dismissible(&market, &amm, NOW).is_ok());
    }

    #[test]
    fn dismissal_is_refused_before_the_trial_window_closes() {
        let market = market_fixture(MarketLifecycle::Open);
        let amm = amm_fixture();
        assert!(assert_dismissible(&market, &amm, amm.trial_end_at - 1).is_err());
    }

    #[test]
    fn dismissal_is_refused_after_settlement() {
        // The P0 invariant: settle → dismiss → claim_refund would pay a
        // position that redeem has already paid, out of the same vault.
        let market = market_fixture(MarketLifecycle::Settled);
        let amm = amm_fixture();
        assert!(assert_dismissible(&market, &amm, NOW).is_err());
    }

    #[test]
    fn dismissal_is_refused_once_the_market_is_locked() {
        // Locked means the outcome is being adjudicated; dismissal from here
        // would race settlement.
        let market = market_fixture(MarketLifecycle::Locked);
        let amm = amm_fixture();
        assert!(assert_dismissible(&market, &amm, NOW).is_err());
    }

    #[test]
    fn dismissal_is_refused_for_a_graduated_market() {
        let market = market_fixture(MarketLifecycle::Open);
        let mut amm = amm_fixture();
        amm.is_graduated = true;
        assert!(assert_dismissible(&market, &amm, NOW).is_err());
    }

    #[test]
    fn dismissal_is_one_shot() {
        let mut market = market_fixture(MarketLifecycle::Open);
        let mut amm = amm_fixture();
        market.is_dismissed = true;
        amm.is_dismissed = true;
        assert!(assert_dismissible(&market, &amm, NOW).is_err());
    }

    #[test]
    fn a_stale_market_flag_alone_still_blocks_a_second_dismissal() {
        // The two flags are written together, but neither is trusted alone.
        let mut market = market_fixture(MarketLifecycle::Open);
        let amm = amm_fixture();
        market.is_dismissed = true;
        assert!(assert_dismissible(&market, &amm, NOW).is_err());
    }
}
