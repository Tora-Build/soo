//! `attest_outcome_zk` — trustless variant of `attest_outcome`.
//!
//! Where the manual path trusts a signer, this path trusts a signature: a
//! Primus zkTLS attestor observed a TLS response, signed what it saw, and the
//! program re-derives the outcome from those signed bytes. Nobody is
//! authorized to call this — anyone holding a valid attestation may submit it,
//! and the submitter's only role is paying the fee.
//!
//! Like the manual path it does NOT settle. The market stays `Locked` and
//! enters the ATTESTED state for the veto window, during which `dispute` may
//! override the outcome; after that anyone may `settle`. That separation is
//! the safety net: if this verifier is ever wrong — a compromised attestor, a
//! feed that changed shape — the guardian can still veto before funds move.
//! Collapsing verification and settlement into one instruction would remove
//! the only recourse against a bad attestation.
//!
//! # What makes an attestation binding
//!
//! Three checks, none of which is sufficient alone:
//!
//! 1. **Signature** — the digest is re-encoded here from the submitted
//!    structured fields (never accepted pre-encoded) and must recover to the
//!    market's registered attestor. This proves an attestor saw the bytes.
//! 2. **`rule_hash`** — the url and parsePath must match what was committed at
//!    registration. Without this, check 1 only proves the attestor saw
//!    *something*: any attestation the same attestor ever signed, for any
//!    endpoint, would otherwise resolve this market.
//! 3. **Timestamp** — the observation's floor depends on WHEN it arrives.
//!    Post-deadline (the market already `Locked`): at or after the deadline,
//!    so a stale mid-trading reading cannot masquerade as the closing one.
//!    Pre-deadline (the market still `Open`): at or after `start_time` — a
//!    mid-trading reading is exactly the point.
//!
//! # Early resolution
//!
//! An automatic market's rule is one-directional by definition here: the
//! moment a verified attestation shows the rule SATISFIED, the outcome is
//! decided — waiting for the deadline adds nothing but time. So a satisfied
//! proof may arrive while the market is still `Open`: this instruction then
//! performs the `Locked` transition itself (the same one
//! `lock_for_resolution` performs for a human) and attests YES atomically.
//! The proof is the authority for both steps, exactly as it already was for
//! one.
//!
//! An UNMET reading proves nothing early — the value may cross the threshold
//! tomorrow — so pre-deadline attestations that do not satisfy the rule are
//! rejected outright, and NO can only ever be attested at or after the
//! deadline, from a reading taken at or after the deadline.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::{MarketLocked, OutcomeAttested, ZkOutcomeAttested};
use crate::state::{AdjudicatorEntry, Market, MarketLifecycle, ADJUDICATOR_ENTRY_SEED};
use crate::zk::{verify_attestation, ZkAttestation};

#[derive(Accounts)]
pub struct AttestOutcomeZk<'info> {
    #[account(
        mut,
        seeds = [ADJUDICATOR_ENTRY_SEED, market.key().as_ref()],
        bump = adjudicator_entry.bump,
        constraint = adjudicator_entry.market == market.key()
            @ SoothCoreError::AmmStateMarketMismatch,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    /// Mutable for ONE transition: a pre-deadline attestation that proves
    /// the rule satisfied performs Open → Locked itself. Settlement still
    /// belongs to `settle`, after the veto window.
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// Fee payer only. This instruction is permissionless by design — the
    /// attestation carries its own authority, so gating submission on a
    /// signer would reintroduce exactly the trusted party being removed.
    pub submitter: Signer<'info>,
}

pub fn handler(ctx: Context<AttestOutcomeZk>, attestation: ZkAttestation) -> Result<()> {
    // Two admissible shapes. `Locked`: the ordinary post-deadline path.
    // `Open`: the early path — admitted provisionally here and pinned below
    // to a SATISFIED verdict with a mid-trading timestamp floor; the
    // lifecycle transition happens in the same instruction, so an Open
    // market still can never sit attested-but-trading.
    let early = matches!(ctx.accounts.market.lifecycle, MarketLifecycle::Open);
    require!(
        early || matches!(ctx.accounts.market.lifecycle, MarketLifecycle::Locked),
        SoothCoreError::InvalidLifecycleTransition
    );
    require!(
        !ctx.accounts.market.is_dismissed,
        SoothCoreError::MarketDismissed
    );
    // One-shot, with the same single exception the manual path makes: an
    // outcome the permissionless abandonment hatch wrote. A zk market whose
    // attestation was merely late must not be stuck with INVALID when a valid
    // Primus attestation finally arrives — and this path is not a trust
    // concession, since the attestation still has to verify against the
    // registered attestor and rule. The write below clears the flag and
    // restarts the veto window.
    require!(
        !ctx.accounts.adjudicator_entry.is_attested()
            || ctx.accounts.adjudicator_entry.is_forced_invalid(),
        SoothCoreError::AlreadyAttested
    );

    let rule = ctx.accounts.adjudicator_entry.require_zk_rule()?;
    // Post-deadline the floor is the deadline: a stale mid-trading reading
    // must not masquerade as the closing one. Pre-deadline the floor is
    // start_time: a mid-trading reading is exactly the point.
    let min_ts = if early {
        ctx.accounts.market.start_time
    } else {
        ctx.accounts.market.deadline
    };
    let verdict = verify_attestation(&attestation, &rule, min_ts)?;
    if early {
        // Only a SATISFIED rule decides anything before the deadline — an
        // unmet reading may be met tomorrow. NO exists only at the deadline.
        require!(
            verdict.winning_outcome == crate::state::market::OUTCOME_YES,
            SoothCoreError::ZkEarlyRequiresSatisfied
        );
    }

    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let adjudicator_entry_key = ctx.accounts.adjudicator_entry.key();

    {
        let entry = &mut ctx.accounts.adjudicator_entry;
        entry.attested_outcome = Some(verdict.winning_outcome);
        entry.attested_at = Some(now);
        entry.forced_invalid = false;
    }

    if early {
        // The transition `lock_for_resolution` performs for a human, done by
        // the proof itself. Same event, so every consumer of MarketLocked
        // keeps working unchanged.
        ctx.accounts.market.lifecycle = MarketLifecycle::Locked;
        emit!(MarketLocked {
            market: market_key,
            ts: now,
        });
    }

    // Both events fire: consumers that only track outcomes keep working
    // unchanged, and auditors get the evidence behind this one.
    emit!(OutcomeAttested {
        market: market_key,
        adjudicator_entry: adjudicator_entry_key,
        winning_outcome: verdict.winning_outcome,
        ts: now,
    });
    emit!(ZkOutcomeAttested {
        market: market_key,
        adjudicator_entry: adjudicator_entry_key,
        attestor_evm: verdict.attestor_evm,
        value: verdict.value,
        threshold: rule.threshold as i64,
        comparator: rule.comparator as u8,
        winning_outcome: verdict.winning_outcome,
        attestation_ts: verdict.attestation_ts,
        ts: now,
    });

    Ok(())
}
