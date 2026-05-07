//! Events emitted by `sooth_market`.
//!
//! Solana logs are best-effort (architecture §3); indexers must subscribe
//! live or rely on the Geyser/webhook pipeline.

use anchor_lang::prelude::*;

#[event]
pub struct MarketInitialized {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub adjudicator: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    pub start_time: i64,
    pub deadline: i64,
    pub ts: i64,
}

/// Mirror of EVM `OrderEngine.Minted` (`OrderEngine.sol:124`).
#[event]
pub struct CompleteSetMinted {
    pub market: Pubkey,
    pub user: Pubkey,
    /// USDC base units pulled from user.
    pub amount_usdc: u64,
    pub ts: i64,
}

/// Mirror of EVM `OrderEngine.Merged` (`OrderEngine.sol:125`).
#[event]
pub struct CompleteSetMerged {
    pub market: Pubkey,
    pub user: Pubkey,
    /// USDC base units returned to user.
    pub amount_usdc: u64,
    pub ts: i64,
}

/// Mirror of EVM `TruthMarket.MarketResolved` (LIVE → RESOLVING). Renamed to
/// "Locked" to match Solana lifecycle names — the semantic intent is the same:
/// trading halts pending adjudicator outcome. See `state/lifecycle.rs`.
#[event]
pub struct MarketLocked {
    pub market: Pubkey,
    pub ts: i64,
}

/// Mirror of EVM `TruthMarket.MarketSettled` (`TruthMarket.sol:130`).
#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    /// 0=NO, 1=YES, 2=INVALID per protocol-wide OUTCOME encoding.
    pub winning_outcome: u8,
    pub ts: i64,
}

/// Mirror of EVM `OrderEngine.PositionSettled` (`OrderEngine.sol:430`).
/// Emitted by `redeem` after a successful post-settlement burn-and-pay.
#[event]
pub struct Redeemed {
    pub user: Pubkey,
    pub market: Pubkey,
    /// Resolved outcome at the time of redeem, copied from
    /// `Market::winning_outcome`. 0=NO, 1=YES, 2=INVALID.
    pub outcome: u8,
    /// YES outcome-token base units burned (0 if user held none, or if
    /// outcome=NO).
    pub yes_burned: u64,
    /// NO outcome-token base units burned (0 if user held none, or if
    /// outcome=YES).
    pub no_burned: u64,
    /// USDC base units transferred from vault to user.
    pub usdc_paid: u64,
    pub ts: i64,
}
