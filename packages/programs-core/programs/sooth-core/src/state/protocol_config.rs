//! `ProtocolConfig` — singleton on-chain protocol configuration.
//!
//! Includes `paused: bool` for the circuit-breaker.
//!
//! ## Fee split (mirrors EVM `FeeRouter` defaults)
//!
//! Architecture §8: `bBase 50% / LP 30% / adjudicator 10% / protocol 10%`.
//! All bps fields must sum to 10_000.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;

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

    /// Circuit-breaker flag. When `true`, `require_not_paused` rejects with
    /// `SoothCoreError::ProtocolPaused`.
    ///
    /// Scope is a TRADING halt, not a total freeze — see `require_not_paused`.
    pub paused: bool,

    /// When `true`, anyone can register an adjudicator for any market.
    /// When `false`, only `config.authority` may call `register_adjudicator`.
    pub permissionless_adjudicators: bool,

    /// Guardian-veto window in seconds. `dispute` is callable while
    /// `now < attested_at + veto_period_secs`; `settle` only after.
    ///
    /// Configurable rather than a constant so localnet can run a few seconds
    /// while devnet runs 24h — same binary in both places. A build flag would
    /// have meant the artifact under test was not the artifact deployed.
    ///
    /// Zero is legal and means "no veto window": settle becomes callable in
    /// the same slot as attest. That is the old collapsed behaviour, opt-in.
    pub veto_period_secs: i64,
}

/// Reject the call if the protocol circuit-breaker is engaged.
///
/// Deliberately scoped to a **trading halt**, not a total freeze. Gated:
/// `buy`, `trade_positions`, `sell_positions`, `seed_lp`, `create_market` —
/// i.e. anything that opens a new position, adds liquidity, or creates a
/// market.
///
/// NOT gated, by design:
///   - `cancel` / `cancel_by_id` — a maker must always be able to pull a
///     resting order; blocking this strands collateral in the book.
///   - `redeem*`, `claim_unlocked`, `claim_refund`, `redeem_lp`,
///     `merge_complete_set*` — exit paths. A pause that traps user funds is
///     its own failure mode, so exits stay open.
///   - resolution and admin flow (`request_lock`, `lock_for_resolution`,
///     `attest_outcome`, `dispute`, `settle`, `dismiss_market`) — a paused
///     protocol must still be able to wind markets down.
///   - `distribute_fees*` — cranks that move already-accrued fees; halting
///     them protects nothing and can strand balances.
///
/// `mint_complete_set*` is also ungated. It is economically neutral (deposit
/// N, receive N YES + N NO, always worth N together) and its account structs
/// do not currently carry `ProtocolConfig`; adding it would change the frozen
/// instruction shape. Revisit if that account is ever added for other reasons.
pub fn require_not_paused(config: &ProtocolConfig) -> Result<()> {
    require!(!config.paused, SoothCoreError::ProtocolPaused);
    Ok(())
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
        + 1                        // permissionless_adjudicators
        + 8; // veto_period_secs

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
