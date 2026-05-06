//! `lock_for_resolution` — halt trading; market enters Locked state pending
//! adjudicator outcome.
//!
//! EVM analogue: `TruthMarket.resolve` (`TruthMarket.sol:90-106`) which
//! transitions LIVE → RESOLVING. On Solana we collapse RESOLVING + ATTESTED
//! into `Locked` (see `state/lifecycle.rs`).
//!
//! ## Authority gating
//!
//! EVM: `require(msg.sender == adjudicator())`. Solana equivalent is a CPI
//! auth check — the adjudicator program is the caller, and we verify
//! `program_id == market.adjudicator`. **Not implemented in this scaffold**:
//! that requires `sooth_adjudicator` to exist with a known CPI shape, per
//! architecture §4.4. The state mutation below is real; the auth check is
//! `todo!()` so any reviewer running this on devnet sees an immediate panic
//! and knows the gate is unenforced.
//!
//! Once `sooth_adjudicator` lands, this becomes:
//!   - `sysvar::instructions` introspection to grab the parent ix's
//!     program_id, OR
//!   - a signer PDA derived from the adjudicator program with seeds
//!     `[b"adj_signer", market_id]`.
//! The architecture doc doesn't pin the choice — defer.

use anchor_lang::prelude::*;

use crate::error::SoothMarketError;
use crate::events::MarketLocked;
use crate::state::{Market, MarketLifecycle};

#[derive(Accounts)]
pub struct LockForResolution<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// Stubbed adjudicator authority signer. In v1 this is the literal
    /// `market.adjudicator` pubkey (signer-style for the manual adjudicator).
    /// In v2 with `sooth_adjudicator` running its own program this becomes
    /// either an instruction-introspection check or a program-derived signer.
    /// CHECK: see module-level note; the auth check is `todo!()`.
    pub adjudicator: Signer<'info>,
}

pub fn handler(ctx: Context<LockForResolution>) -> Result<()> {
    // ── Auth — STUB ──────────────────────────────────────────────────────
    //
    // TODO(architecture §4.4): replace with the adjudicator-CPI auth check
    // once `sooth_adjudicator` is wired. Until then, accept any signer whose
    // pubkey matches `market.adjudicator` — this is a minimal real-but-loose
    // gate; the production version verifies the CPI parent program. Panic
    // with `todo!()` if the field is unset (defense-in-depth so a
    // misconfigured market can't be locked by anyone).
    if ctx.accounts.market.adjudicator == Pubkey::default() {
        todo!("adjudicator-CPI auth check not yet wired; see architecture §4.4");
    }
    require_keys_eq!(
        ctx.accounts.adjudicator.key(),
        ctx.accounts.market.adjudicator,
        SoothMarketError::NotAdjudicator
    );

    let market = &mut ctx.accounts.market;
    require!(
        market.lifecycle.can_transition_to(MarketLifecycle::Locked),
        SoothMarketError::InvalidLifecycleTransition
    );
    market.lifecycle = MarketLifecycle::Locked;

    let now = Clock::get()?.unix_timestamp;
    emit!(MarketLocked {
        market: market.key(),
        ts: now,
    });

    Ok(())
}
