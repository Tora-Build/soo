//! `initialize_protocol` — singleton init for the cluster's `ProtocolConfig`.
//!
//! REAL handler. Mirrors EVM `LaunchpadEngine` constructor + the post-deploy
//! setter calls collapsed. Architecture §2.1.
//!
//! ## Accounts created
//!
//! - `ProtocolConfig` PDA   seeds = `[b"protocol_config"]`
//!
//! ## Single-shot guarantee
//!
//! `init` (not `init_if_needed`) on a no-entropy seed means re-call returns
//! `account already in use` from the runtime. The handler does not need to
//! manually check `AlreadyInitialized` — the constraint covers it.
//!
//! ## Out of scope (deferred to follow-up commits)
//!
//! - `update_fee_bps`, `update_treasury`, `update_default_trial_period`
//!   setters (need 2/N multisig gating per security checklist).
//! - `pause` / `unpause`. EVM has these on `LaunchpadEngine` (`whenNotPaused`
//!   modifier on `createMarket`); on Solana the same flag would gate
//!   `create_market` here. Defer until a real pause use-case appears.

use anchor_lang::prelude::*;

use crate::error::SoothLaunchpadError;
use crate::events::ProtocolInitialized;
use crate::state::{protocol_config::MAX_FEE_BPS, ProtocolConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeProtocolArgs {
    /// Total per-trade fee in basis points. Bounded ≤ 10_000 (100%).
    pub fee_bps: u16,
    /// USDC ATA where protocol's slice of fees lands. Must be non-default.
    pub treasury: Pubkey,
    /// 4-way fee split bps. Must sum to 10_000.
    pub b_base_share_bps: u16,
    pub lp_yield_share_bps: u16,
    pub adjudicator_share_bps: u16,
    pub protocol_share_bps: u16,
    /// Default trial period in seconds. EVM analogue: `defaultTrialPeriod` on
    /// `LaunchpadEngine`. The concrete `trial_end_at` per-market is computed
    /// in `create_market` (architecture §9).
    pub default_trial_period: i64,
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    /// New `ProtocolConfig` singleton. `init` (not `init_if_needed`) — re-init
    /// must be impossible. Seeds have no entropy, so the second caller hits
    /// `account already in use` from the runtime.
    #[account(
        init,
        payer = authority,
        space = ProtocolConfig::SPACE,
        seeds = [b"protocol_config"],
        bump,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeProtocol>, args: InitializeProtocolArgs) -> Result<()> {
    require!(
        args.fee_bps <= MAX_FEE_BPS,
        SoothLaunchpadError::FeeBpsOutOfRange
    );
    require!(
        args.treasury != Pubkey::default(),
        SoothLaunchpadError::InvalidTreasury
    );
    require!(
        args.default_trial_period > 0,
        SoothLaunchpadError::InvalidTrialPeriod
    );

    let split_total = (args.b_base_share_bps as u32)
        + (args.lp_yield_share_bps as u32)
        + (args.adjudicator_share_bps as u32)
        + (args.protocol_share_bps as u32);
    require!(split_total == 10_000, SoothLaunchpadError::FeeSplitMismatch);

    let cfg = &mut ctx.accounts.config;
    cfg.authority = ctx.accounts.authority.key();
    cfg.treasury = args.treasury;
    cfg.fee_bps = args.fee_bps;
    cfg.b_base_share_bps = args.b_base_share_bps;
    cfg.lp_yield_share_bps = args.lp_yield_share_bps;
    cfg.adjudicator_share_bps = args.adjudicator_share_bps;
    cfg.protocol_share_bps = args.protocol_share_bps;
    cfg.default_trial_period = args.default_trial_period;
    cfg.bump = ctx.bumps.config;

    // Defensive: if a future field rotation breaks the invariant, surface it
    // at write-time rather than silently storing a 9_999-summing config.
    require!(
        cfg.split_total() == 10_000,
        SoothLaunchpadError::FeeSplitMismatch
    );

    let now = Clock::get()?.unix_timestamp;
    emit!(ProtocolInitialized {
        authority: cfg.authority,
        treasury: cfg.treasury,
        fee_bps: cfg.fee_bps,
        ts: now,
    });

    Ok(())
}
