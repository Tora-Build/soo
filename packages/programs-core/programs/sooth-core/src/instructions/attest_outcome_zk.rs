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
//! 3. **Timestamp** — the observation must be at or after the market's
//!    deadline, so a reading taken while the market was still trading cannot
//!    resolve it.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::{OutcomeAttested, ZkOutcomeAttested};
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

    /// Read-only: attestation does not change the lifecycle. `settle` does
    /// that, after the veto window.
    #[account(
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
    // Attestation must gate the lifecycle itself — otherwise an Open market
    // could be attested and would then settle straight out of trading once
    // the veto window elapsed.
    require!(
        matches!(ctx.accounts.market.lifecycle, MarketLifecycle::Locked),
        SoothCoreError::InvalidLifecycleTransition
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
    // The observation must be at or after the deadline, so a reading taken
    // while the market was still trading cannot resolve it.
    let verdict = verify_attestation(&attestation, &rule, ctx.accounts.market.deadline)?;

    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let adjudicator_entry_key = ctx.accounts.adjudicator_entry.key();

    {
        let entry = &mut ctx.accounts.adjudicator_entry;
        entry.attested_outcome = Some(verdict.winning_outcome);
        entry.attested_at = Some(now);
        entry.forced_invalid = false;
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
