//! `dispute` — STUB. Architecture §4.4 sketches a veto branch on the
//! `resolve → attest → settle` flow. v1 collapses RESOLVING + ATTESTED into
//! `Locked` on the market state, so the dispute path can re-enter as a
//! separate ix later without bloating the v1 state machine.
//!
//! When this lands the body will:
//!   - re-open the lifecycle (or transition to a new `Disputed` state)
//!   - clear `adjudicator.attested_outcome` so re-attestation is permitted
//!   - emit `DisputeRaised`
//!   - optionally rotate authority (e.g. escalate to a guardian multisig)
//!
//! For now the Accounts struct is committed for IDL stability and the body
//! is `todo!()` — same convention as `sooth_launchpad::create_market`.

use anchor_lang::prelude::*;

use sooth_market::state::Market;

use crate::error::SoothAdjudicatorError;
use crate::state::{Adjudicator, ADJUDICATOR_SEED};

#[derive(Accounts)]
pub struct Dispute<'info> {
    /// Per-market `Adjudicator` PDA — would be mutated to clear the
    /// attestation when the dispute path lands.
    #[account(
        mut,
        seeds = [ADJUDICATOR_SEED, market.key().as_ref()],
        bump = adjudicator.bump,
        constraint = adjudicator.market == market.key()
            @ SoothAdjudicatorError::MarketMismatch,
    )]
    pub adjudicator: Account<'info, Adjudicator>,

    /// `sooth_market::Market` PDA — read-only for IDL shape; the future
    /// CPI surface (e.g. `unlock_for_dispute`) is not yet defined.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Account<'info, Market>,

    /// Disputer signer. The dispute-authority model is not pinned in v1 —
    /// it could be the per-market authority, a guardian multisig, or an
    /// open permissionless path with a bond. Architecture §4.4 leaves this
    /// open. The IDL shape commits a generic `Signer` for now.
    pub disputer: Signer<'info>,
}

#[allow(unused_variables)]
pub fn handler(ctx: Context<Dispute>) -> Result<()> {
    // STUB — see module docstring. Returning the dedicated error code so a
    // tx that hits this path on a deployed program gets a clear "not
    // implemented" signal rather than a generic InstructionError.
    Err(error!(SoothAdjudicatorError::DisputeNotImplemented))
}
