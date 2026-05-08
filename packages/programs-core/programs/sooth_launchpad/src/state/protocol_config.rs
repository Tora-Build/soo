//! `ProtocolConfig` — singleton. Architecture §2.1.
//!
//! Holds the protocol-level fee config and treasury pubkey. There is exactly
//! one of these per deploy; the seed is the constant string `"protocol_config"`
//! with no entropy, so re-init must be impossible (the `init` constraint in
//! `initialize_protocol` enforces this — re-call returns
//! `account already in use` from the runtime).
//!
//! ## Fee split (mirrors EVM `FeeRouter` defaults)
//!
//! Architecture §8: `bBase 50% / LP 30% / adjudicator 10% / protocol 10%`.
//! All bps fields must sum to 10_000. The split is mutable (a future
//! `update_fee_split` ix can rotate them), but the **fee bps total** is a
//! per-trade cost ceiling and is bounded ≤ 10_000 in `initialize_protocol`.

use anchor_lang::prelude::*;

#[account]
pub struct ProtocolConfig {
    /// Pubkey allowed to call setters. Equals `creator` of the
    /// `initialize_protocol` ix. Rotation is intentionally **not** wired in
    /// this scaffold — when it lands, gate it on a 2/N multisig per the
    /// security checklist.
    pub authority: Pubkey,

    /// USDC ATA where the protocol's slice of every fee distribution lands.
    /// Validated non-default at init.
    pub treasury: Pubkey,

    /// Total fee taken on each trade, in basis points (1 bp = 0.01%). EVM's
    /// `preGradFeeBps` and `postGradFeeBps` collapse to a single field for
    /// the v1 surface; the pre/post split lives on `AmmState.is_graduated`
    /// and the *destinations* split (below) handles the difference.
    pub fee_bps: u16,

    /// 4-way split bps — must sum to 10_000. Architecture §8.
    pub b_base_share_bps: u16,
    pub lp_yield_share_bps: u16,
    pub adjudicator_share_bps: u16,
    pub protocol_share_bps: u16,

    /// Default trial period in seconds. Mirrors EVM `defaultTrialPeriod`. The
    /// concrete `trial_end_at` is computed per-market in `create_market` per
    /// architecture §9: `min(0.3 × (deadline - now), default_trial_period)`.
    pub default_trial_period: i64,

    /// Bump for the singleton PDA.
    pub bump: u8,
}

impl ProtocolConfig {
    /// Borsh-serialized size for rent calculation. 8-byte discriminator added
    /// by `#[account]`. Update if fields change.
    pub const SPACE: usize = 8     // discriminator
        + 32                       // authority
        + 32                       // treasury
        + 2                        // fee_bps
        + 2 + 2 + 2 + 2            // 4 share bps
        + 8                        // default_trial_period
        + 1; // bump

    /// Total of the four share bps. Used by `initialize_protocol` to enforce
    /// the sum-to-10_000 invariant before writing the account.
    pub fn split_total(&self) -> u32 {
        self.b_base_share_bps as u32
            + self.lp_yield_share_bps as u32
            + self.adjudicator_share_bps as u32
            + self.protocol_share_bps as u32
    }
}

/// Sentinel — fee bps must not exceed 100% (10_000 bps).
pub const MAX_FEE_BPS: u16 = 10_000;

// ── Cross-crate layout sync ──────────────────────────────────────────────
//
// `sooth_amm::trade_positions` parses `ProtocolConfig` raw from account
// data via the byte offsets in `sooth-account-offsets`. The constants
// there are duplicated against the field layout above because Cargo's
// cyclic-dep ban (sooth_amm path-dep on sooth_launchpad) prevents a
// cleaner solution: `sooth_launchpad` already declares `sooth_amm` as a
// `cpi`-feature path dep for `create_market`'s composition, so the reverse
// edge would close a cycle. This assertion ties the two ends together:
// any future change to `ProtocolConfig` field list that alters the byte
// layout must update `sooth-account-offsets` too, or the build fails.
//
// `ProtocolConfig` is `#[account]` — Borsh serialised, no `#[repr(C)]` —
// so `core::mem::offset_of!` returns Rust's in-memory offsets, not the
// on-chain byte offsets. Same convention used for `Position` /
// `LockEntry` (see their state files).
const _: () = assert!(
    ProtocolConfig::SPACE == sooth_account_offsets::PROTOCOL_CONFIG_TOTAL_LEN,
    "ProtocolConfig::SPACE drifted from \
     sooth-account-offsets::PROTOCOL_CONFIG_TOTAL_LEN — update both, including \
     the per-field offsets in sooth-account-offsets/src/lib.rs"
);
