//! Events emitted by `sooth_launchpad`.
//!
//! Solana logs are best-effort (architecture §3); indexers must subscribe live
//! or rely on the Geyser/webhook pipeline. Mirror EVM `LaunchpadEngine` events
//! so the existing indexer/SDK surface keeps a 1:1 schema.

use anchor_lang::prelude::*;

/// Mirror of EVM `LaunchpadEngine.MarketCreated`. Emitted by `create_market`
/// after the four CPI legs land (architecture §4.1).
#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub adjudicator: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    /// Initial LMSR liquidity `b` in WAD. Stored on `AmmState` after ix4.
    pub initial_b: u128,
    pub start_time: i64,
    pub deadline: i64,
    pub ts: i64,
}

/// Mirror of EVM `FeeRouter.FeesDistributed`. Emitted by `distribute_fees`
/// when the accumulator drains to the four destinations (architecture §8).
#[event]
pub struct FeesCollected {
    pub market: Pubkey,
    /// Total fees moved out of `AmmState.fee_b_base_wad` in this call (WAD).
    pub total_wad: u128,
    /// Slice routed to the bBase LP-yield ATA.
    pub to_b_base: u64,
    pub to_lp_yield: u64,
    pub to_adjudicator: u64,
    pub to_protocol: u64,
    pub ts: i64,
}

/// Emitted once per protocol deploy by `initialize_protocol`. Indexers can
/// pin the cluster's authority + treasury without re-reading the PDA.
#[event]
pub struct ProtocolInitialized {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub ts: i64,
}
