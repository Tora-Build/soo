//! `attest_outcome` — Manual variant. The per-market authority signs a
//! `winning_outcome`, recording it on the `AdjudicatorEntry`.
//!
//! It does NOT settle. The market stays `Locked` and enters the ATTESTED
//! state for `VETO_PERIOD_SECS`, during which `dispute` may override the
//! outcome; after that window anyone may call `settle` to finalize.
//!
//! Attest and settle MUST stay separate instructions: `dispute` requires
//! both `is_attested()` and a not-yet-`Settled` market, so collapsing
//! attest+settle into one transaction would leave no market ever in both
//! states at once and make every dispute fail with `MarketAlreadySettled`
//! or `NotYetAttested`. `sdk-solana/tests/adjudicator-flow.test.ts` pins
//! both branches. The split matches the EVM contract, where `resolve` and
//! a permissionless `settle` are distinct calls either side of
//! `vetoEndsAt`.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::OutcomeAttested;
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::{AdjudicatorEntry, Market, MarketLifecycle, ADJUDICATOR_ENTRY_SEED};

#[derive(Accounts)]
pub struct AttestOutcome<'info> {
    #[account(
        mut,
        seeds = [ADJUDICATOR_ENTRY_SEED, market.key().as_ref()],
        bump = adjudicator_entry.bump,
        constraint = adjudicator_entry.market == market.key()
            @ SoothCoreError::AmmStateMarketMismatch,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    /// Read-only: attestation does not change the lifecycle. `settle` does
    /// that, after the veto window.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    pub authority: Signer<'info>,
}

/// Attestation is one-shot, with exactly one exception: an outcome the
/// ABANDONMENT escape hatch wrote.
///
/// `force_invalid_attestation` is permissionless and fires purely on a
/// timeout, so treating what it wrote as final would let a stranger take a
/// market away from an adjudicator who was merely late. Letting the real
/// authority attest over it — and restarting the veto window, since the
/// handler rewrites `attested_at` — makes the hatch a fallback rather than a
/// race.
///
/// It does not become a general amend: a FORCED outcome is the only one this
/// admits, the handler clears `forced_invalid` as it writes, and the hatch
/// cannot re-fire against an attested entry. Amending a real attestation is
/// still `dispute`'s job, under the dispute authority.
fn assert_attestable(entry: &AdjudicatorEntry) -> Result<()> {
    require!(
        !entry.is_attested() || entry.is_forced_invalid(),
        SoothCoreError::AlreadyAttested
    );
    Ok(())
}

pub fn handler(ctx: Context<AttestOutcome>, winning_outcome: u8) -> Result<()> {
    require!(
        winning_outcome == OUTCOME_NO
            || winning_outcome == OUTCOME_YES
            || winning_outcome == OUTCOME_INVALID,
        SoothCoreError::InvalidOutcome
    );

    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.adjudicator_entry.authority,
        SoothCoreError::Unauthorized
    );

    assert_attestable(&ctx.accounts.adjudicator_entry)?;

    // Attestation must gate the lifecycle itself — otherwise an Open market
    // could be attested and would then settle straight out of trading once
    // the veto window elapsed.
    require!(
        matches!(ctx.accounts.market.lifecycle, MarketLifecycle::Locked),
        SoothCoreError::InvalidLifecycleTransition
    );

    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let adjudicator_entry_key = ctx.accounts.adjudicator_entry.key();

    {
        let entry = &mut ctx.accounts.adjudicator_entry;
        entry.attested_outcome = Some(winning_outcome);
        entry.attested_at = Some(now);
        entry.forced_invalid = false;
    }

    emit!(OutcomeAttested {
        market: market_key,
        adjudicator_entry: adjudicator_entry_key,
        winning_outcome,
        ts: now,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instructions::settle::tests::silent_entry;

    #[test]
    fn a_fresh_entry_is_attestable() {
        assert!(assert_attestable(&silent_entry(Pubkey::new_unique())).is_ok());
    }

    #[test]
    fn a_real_attestation_is_one_shot() {
        let mut entry = silent_entry(Pubkey::new_unique());
        entry.attested_outcome = Some(OUTCOME_YES);
        entry.attested_at = Some(1_000);
        assert!(assert_attestable(&entry).is_err());
    }

    #[test]
    fn the_authority_may_attest_over_a_forced_invalid() {
        // The regression for the escape hatch's one real risk: a stranger
        // forcing INVALID onto a market whose adjudicator was merely late
        // must not be able to keep it there.
        let mut entry = silent_entry(Pubkey::new_unique());
        entry.attested_outcome = Some(OUTCOME_INVALID);
        entry.attested_at = Some(1_000);
        entry.forced_invalid = true;
        assert!(assert_attestable(&entry).is_ok());
    }

    #[test]
    fn attesting_over_a_forced_outcome_closes_the_door_behind_it() {
        // The overwrite clears the flag, so the exception is used once and
        // the entry goes back to being one-shot.
        let mut entry = silent_entry(Pubkey::new_unique());
        entry.attested_outcome = Some(OUTCOME_INVALID);
        entry.attested_at = Some(1_000);
        entry.forced_invalid = true;
        assert!(assert_attestable(&entry).is_ok());

        // What the handler writes.
        entry.attested_outcome = Some(OUTCOME_NO);
        entry.attested_at = Some(2_000);
        entry.forced_invalid = false;
        assert!(assert_attestable(&entry).is_err());
    }
}
