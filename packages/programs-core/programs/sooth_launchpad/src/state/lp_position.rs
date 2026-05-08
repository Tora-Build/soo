//! `LpPosition` — per-(creator, market) LP claim record.
//!
//! Architecture §1 row 7 (`LaunchpadLPToken` → SPL mint owned by launchpad
//! PDA). The actual LP **token** is an SPL Mint — free transferability — but
//! we keep a per-creator `LpPosition` PDA alongside it to record the seed
//! deposit and graduation timestamp, mirroring the `MarketState` struct in
//! EVM `LaunchpadEngine`. This lets `dismiss_market` (architecture §9)
//! refund the seed deposit without scanning SPL token balances.
//!
//! ## Status: STUB shape
//!
//! Field set is intentionally lean — extend as `seed_lp` and the dismiss/refund
//! flow land. Marked `pub` everywhere so the SDK can bind to it via Anchor's
//! IDL generator without needing accessor helpers.

use anchor_lang::prelude::*;

#[account]
pub struct LpPosition {
    /// Backlink to the market PDA.
    pub market: Pubkey,

    /// Pubkey of the creator. Equal to `market.creator` at init time; stored
    /// here so `claim_refund` doesn't need to deserialize `Market` to verify.
    pub creator: Pubkey,

    /// LP-token mint for this market — SPL Mint at `[b"lp", market_id]`.
    pub lp_mint: Pubkey,

    /// Creator's seed deposit in WAD, bookkeeping only (the funds are in the
    /// market's USDC vault). Equals `b_base * ln(2)` per EVM
    /// `LaunchpadEngine.MIN_DEPOSIT_WAD` rationale.
    pub seed_deposit_wad: u128,

    /// Unix seconds at which the market graduated. 0 = not graduated.
    pub graduated_at: i64,

    /// Bump for this PDA. Seeds = `[b"lp_position", market_id, creator]`.
    pub bump: u8,
}

impl LpPosition {
    pub const SPACE: usize = 8     // discriminator
        + 32                       // market
        + 32                       // creator
        + 32                       // lp_mint
        + 16                       // seed_deposit_wad
        + 8                        // graduated_at
        + 1; // bump
}
