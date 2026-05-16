//! `MarketLifecycle` — state machine for the market lifecycle.

use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketLifecycle {
    Initializing,
    Open,
    Locked,
    Settled,
}

impl MarketLifecycle {
    /// Returns true if transitioning from `self` → `target` is a valid
    /// one-step forward transition.
    pub fn can_transition_to(&self, target: MarketLifecycle) -> bool {
        matches!(
            (self, target),
            (MarketLifecycle::Initializing, MarketLifecycle::Open)
                | (MarketLifecycle::Open, MarketLifecycle::Locked)
                | (MarketLifecycle::Locked, MarketLifecycle::Settled)
        )
    }
}
