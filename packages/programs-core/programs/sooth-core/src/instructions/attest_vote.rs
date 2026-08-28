//! `attest_vote` and the attestor-roster management — committee ruling.
//!
//! `attestor_update` (add/remove/threshold) is the entry authority's tool:
//! the adjudicator convenes their committee. `attest_vote` is a member's
//! ballot: votes accumulate on the `AttestorSet`, and the ballot that brings
//! agreeing votes to the threshold WRITES the attestation — from that point
//! the market is indistinguishable from one ruled by a single key: same veto
//! window, same settle, same `OutcomeAttested` event.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::{AttestorRosterChanged, OutcomeAttested, QuorumVoteCast};
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::{
    AdjudicatorEntry, AttestorSet, AttestorSetError, Market, MarketLifecycle,
    ADJUDICATOR_ENTRY_SEED, ATTESTOR_SET_SEED,
};

fn map_set_err(e: AttestorSetError) -> anchor_lang::error::Error {
    match e {
        AttestorSetError::AlreadyPresent => error!(SoothCoreError::GuardianAlreadyPresent),
        AttestorSetError::Full => error!(SoothCoreError::GuardianSetFull),
        AttestorSetError::NotFound => error!(SoothCoreError::GuardianNotFound),
    }
}

// ─── attestor_update ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct AttestorUpdate<'info> {
    #[account(
        seeds = [ADJUDICATOR_ENTRY_SEED, adjudicator_entry.market.as_ref()],
        bump = adjudicator_entry.bump,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    #[account(
        init_if_needed,
        payer = authority,
        space = AttestorSet::SIZE,
        seeds = [ATTESTOR_SET_SEED, adjudicator_entry.market.as_ref()],
        bump,
    )]
    pub attestor_set: Account<'info, AttestorSet>,

    #[account(
        mut,
        constraint = authority.key() == adjudicator_entry.authority
            @ SoothCoreError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// `action`: 0 = add `key`, 1 = remove `key`, 2 = set threshold to `value`.
pub fn handle_update(
    ctx: Context<AttestorUpdate>,
    action: u8,
    key: Pubkey,
    value: u8,
) -> Result<()> {
    let set = &mut ctx.accounts.attestor_set;
    if set.market == Pubkey::default() {
        set.market = ctx.accounts.adjudicator_entry.market;
        set.bump = ctx.bumps.attestor_set;
    }
    match action {
        0 => {
            require!(key != Pubkey::default(), SoothCoreError::InvalidOutcome);
            set.add(key).map_err(map_set_err)?;
        }
        1 => {
            set.remove(&key).map_err(map_set_err)?;
        }
        2 => {
            require!(
                value >= 1 && value <= set.count,
                SoothCoreError::QuorumThresholdInvalid
            );
            set.threshold = value;
        }
        _ => return Err(error!(SoothCoreError::InvalidOutcome)),
    }
    emit!(AttestorRosterChanged {
        market: set.market,
        count: set.count,
        threshold: set.threshold,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

// ─── attest_vote ────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct AttestVote<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [ADJUDICATOR_ENTRY_SEED, market.key().as_ref()],
        bump = adjudicator_entry.bump,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    #[account(
        mut,
        seeds = [ATTESTOR_SET_SEED, market.key().as_ref()],
        bump = attestor_set.bump,
    )]
    pub attestor_set: Account<'info, AttestorSet>,

    pub voter: Signer<'info>,
}

pub fn handle_vote(ctx: Context<AttestVote>, outcome: u8) -> Result<()> {
    require!(
        outcome == OUTCOME_NO || outcome == OUTCOME_YES || outcome == OUTCOME_INVALID,
        SoothCoreError::InvalidOutcome
    );
    // Same lifecycle gate as the single-key attest: ruling happens on a
    // LOCKED market, and never over a standing attestation (a forced INVALID
    // may be voted over, mirroring attest_outcome's rescue-override).
    require!(
        matches!(ctx.accounts.market.lifecycle, MarketLifecycle::Locked),
        SoothCoreError::InvalidLifecycleTransition
    );
    let entry = &ctx.accounts.adjudicator_entry;
    require!(
        !entry.is_attested() || entry.is_forced_invalid(),
        SoothCoreError::AlreadyAttested
    );
    require!(
        ctx.accounts.attestor_set.threshold >= 1,
        SoothCoreError::QuorumThresholdInvalid
    );

    let voter = ctx.accounts.voter.key();
    let agreeing = ctx
        .accounts
        .attestor_set
        .vote(&voter, outcome)
        .map_err(map_set_err)?;
    let threshold = ctx.accounts.attestor_set.threshold;
    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();

    emit!(QuorumVoteCast {
        market: market_key,
        voter,
        outcome,
        agreeing,
        threshold,
        ts: now,
    });

    if agreeing >= threshold {
        let entry = &mut ctx.accounts.adjudicator_entry;
        entry.attested_outcome = Some(outcome);
        entry.attested_at = Some(now);
        entry.forced_invalid = false;
        emit!(OutcomeAttested {
            market: market_key,
            adjudicator_entry: entry.key(),
            winning_outcome: outcome,
            ts: now,
        });
    }
    Ok(())
}
