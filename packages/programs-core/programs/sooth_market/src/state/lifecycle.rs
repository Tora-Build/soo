//! `MarketLifecycle` — the lifecycle state machine.
//!
//! Mirror of EVM `TruthMarket.MarketState` (`TruthMarket.sol:42-47`):
//!   LIVE → RESOLVING → ATTESTED → SETTLED
//!
//! On Solana we collapse RESOLVING and ATTESTED into a single `Locked` state.
//! Rationale: the EVM split exists because the adjudicator dispatches `resolve`
//! and `attest` as separate calls (with a guardian veto window in between);
//! on Solana the adjudicator is its own program and the dispute path can be
//! re-introduced as a separate ix later without bloating the v1 state machine.
//! Architecture §4.4 already anticipates this collapse — the v1 surface is
//! `Open → Locked → Settled` plus a transient `Initializing` for the
//! create-then-configure window.
//!
//! Spec gap noted (see report): EVM TruthMarket also has `invalidate()` that
//! anyone can call after `deadline + invalidationBuffer` to force the market
//! to SETTLED with outcome=INVALID. Architecture doc §4.4 doesn't enumerate
//! this fallback. Out-of-scope for this scaffold; flag in report.

use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketLifecycle {
    /// Mints + vault created, market not yet open for trading. Transient — the
    /// canonical happy path is `initialize_market` immediately moves to `Open`.
    /// Reserved for future "configure then open" flows.
    Initializing,
    /// Trading and minting/merging is active. EVM equivalent: LIVE.
    Open,
    /// Trading halted, awaiting adjudicator outcome. EVM equivalent: RESOLVING
    /// + ATTESTED (collapsed; see module comment).
    Locked,
    /// Outcome finalized; redemption open. EVM equivalent: SETTLED. Terminal.
    Settled,
}

impl MarketLifecycle {
    /// Encoded size for `Market::SPACE`. 1 byte enum tag + 0 payload bytes
    /// (none of the variants carry data).
    pub const SPACE: usize = 1;

    /// Pure state-machine transition check. Used both as guard inside
    /// instruction handlers and from the host-side unit tests in
    /// `tests/lifecycle.rs`.
    pub fn can_transition_to(&self, next: MarketLifecycle) -> bool {
        use MarketLifecycle::*;
        matches!(
            (*self, next),
            (Initializing, Open) | (Open, Locked) | (Locked, Settled)
        )
    }
}
