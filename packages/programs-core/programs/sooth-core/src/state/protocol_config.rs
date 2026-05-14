//! `ProtocolConfig` — singleton on-chain protocol configuration.
//!
//! Merged from `sooth_launchpad::state::ProtocolConfig`. Adds `paused: bool`
//! for the circuit-breaker pattern requested in the merge spec.
//!
//! ## Fee split (mirrors EVM `FeeRouter` defaults)
//!
//! Architecture §8: `bBase 50% / LP 30% / adjudicator 10% / protocol 10%`.
//! All bps fields must sum to 10_000.

use anchor_lang::prelude::*;

use crate::constants::PROTOCOL_CONFIG_TOTAL_LEN;

/// Singleton PDA seed.
pub const PROTOCOL_CONFIG_SEED: &[u8] = b"protocol_config";

/// Sentinel — fee bps must not exceed 100% (10_000 bps).
pub const MAX_FEE_BPS: u16 = 10_000;

#[account]
pub struct ProtocolConfig {
    /// Authority that may call setters (pause/unpause, future update ixs).
    pub authority: Pubkey,

    /// USDC ATA where the protocol's slice of every fee distribution lands.
    pub treasury: Pubkey,

    /// Total per-trade fee in basis points (1 bp = 0.01 %).
    pub fee_bps: u16,

    /// 4-way fee-destination split bps — must sum to 10_000.
    pub b_base_share_bps: u16,
    pub lp_yield_share_bps: u16,
    pub adjudicator_share_bps: u16,
    pub protocol_share_bps: u16,

    /// Default trial period in seconds. Architecture §9.
    pub default_trial_period: i64,

    /// PDA bump.
    pub bump: u8,

    /// Circuit-breaker flag. When `true`, instructions that check
    /// `require_not_paused` will reject with `SoothCoreError::ProtocolPaused`.
    pub paused: bool,

    /// When `true`, anyone can register an adjudicator for any market.
    /// When `false`, only `config.authority` may call `register_adjudicator`.
    pub permissionless_adjudicators: bool,
}

impl ProtocolConfig {
    pub const SPACE: usize = 8     // discriminator
        + 32                       // authority
        + 32                       // treasury
        + 2                        // fee_bps
        + 2 + 2 + 2 + 2            // 4 share bps
        + 8                        // default_trial_period
        + 1                        // bump
        + 1                        // paused
        + 1; // permissionless_adjudicators

    pub fn split_total(&self) -> u32 {
        self.b_base_share_bps as u32
            + self.lp_yield_share_bps as u32
            + self.adjudicator_share_bps as u32
            + self.protocol_share_bps as u32
    }
}

/// Compile-time assert: ProtocolConfig::SPACE must match PROTOCOL_CONFIG_TOTAL_LEN.
const _: () = assert!(
    ProtocolConfig::SPACE == PROTOCOL_CONFIG_TOTAL_LEN,
    "ProtocolConfig::SPACE drifted from \
     constants::PROTOCOL_CONFIG_TOTAL_LEN — update both"
);
