//! Events emitted by `sooth_amm`.
//!
//! Solana logs are best-effort (architecture §3 — "events as source-of-truth
//! is not a Solana primitive"). Indexers must subscribe live or rely on the
//! Geyser/webhook pipeline; downstream code must not treat absence-of-event
//! as state-of-truth.

use anchor_lang::prelude::*;

#[event]
pub struct PositionTraded {
    pub market: Pubkey,
    pub user: Pubkey,
    /// 0 = NO, 1 = YES (matches protocol-wide OUTCOME encoding).
    pub outcome: u8,
    /// Signed share delta in WAD. Positive = buy; negative = sell.
    pub delta_shares: i128,
    /// Signed cost in WAD. Positive = paid; negative = proceeds (sell).
    pub cost_wad: i128,
    /// Unix timestamp from `Clock`.
    pub ts: i64,
}

// Stubbed for now — referenced from the architecture spec but not wired in
// this scaffold. See architecture §8 (fee router).
#[event]
pub struct LiquidityProvided {
    pub market: Pubkey,
    pub user: Pubkey,
    pub lp_amount: u64,
    pub ts: i64,
}
