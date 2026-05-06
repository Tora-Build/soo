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

/// Emitted on the sell branch of `trade_positions` after the proceeds have
/// been moved into the per-sell `LockEntry` PDA. Mirrors the EVM
/// `ProceedsLocked` event (`AMMEngine.sol:1011-1013`).
#[event]
pub struct PositionSold {
    pub market: Pubkey,
    pub user: Pubkey,
    /// 0 = NO, 1 = YES.
    pub outcome: u8,
    /// Absolute share count sold (positive). Matches `|delta_shares|`.
    pub shares_sold: u128,
    /// Lock account that escrows the USDC proceeds. The corresponding
    /// `claim_unlocked` ix takes this pubkey as input.
    pub lock_entry: Pubkey,
    /// USDC base units escrowed (matches `lock_entry.amount_usdc`).
    pub amount_usdc: u64,
    /// Unix timestamp at which `claim_unlocked` becomes callable.
    pub unlock_at: i64,
}

/// Emitted by `claim_unlocked` after a successful payout. Mirrors the EVM
/// `LocksProcessed`/`LockEntryRemoved` event family
/// (`AMMEngine.sol:392-407`).
#[event]
pub struct LockClaimed {
    pub market: Pubkey,
    pub user: Pubkey,
    pub lock_entry: Pubkey,
    pub amount_usdc: u64,
    pub ts: i64,
}
