//! `initialize_protocol` — singleton init for the cluster's `ProtocolConfig`.
//!
//! Initializes `paused: false` for the circuit-breaker field.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::ProtocolInitialized;
use crate::state::{protocol_config::MAX_FEE_BPS, ProtocolConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeProtocolArgs {
    pub amm_fee_bps: u16,
    pub book_fee_bps: u16,
    pub treasury: Pubkey,
    pub b_base_share_bps: u16,
    pub lp_yield_share_bps: u16,
    pub adjudicator_share_bps: u16,
    pub protocol_share_bps: u16,
    pub default_trial_period: i64,
    pub permissionless_adjudicators: bool,
    /// Guardian-veto window in seconds. Use `DEFAULT_VETO_PERIOD_SECS` (24h)
    /// for real deployments; localnet fixtures pass a few seconds so the
    /// resolve → settle → redeem flow is exercisable in one test run.
    pub veto_period_secs: i64,
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
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
        args.amm_fee_bps <= MAX_FEE_BPS,
        SoothCoreError::FeeBpsOutOfRange
    );
    require!(
        args.book_fee_bps <= MAX_FEE_BPS,
        SoothCoreError::FeeBpsOutOfRange
    );
    require!(
        args.treasury != Pubkey::default(),
        SoothCoreError::InvalidTreasury
    );
    require!(
        args.default_trial_period > 0,
        SoothCoreError::InvalidTrialPeriod
    );

    // Bounded on both sides, and strictly positive.
    //
    // Zero is rejected rather than treated as "no veto window", because the
    // Anchor client encodes a MISSING i64 argument as 0. A caller who simply
    // forgets `vetoPeriodSecs` would otherwise silently deploy a protocol
    // where dispute can never fire and settle is immediate — exactly the
    // collapsed behaviour this split exists to remove, reintroduced by typo.
    // Deployments that genuinely want no delay pass 1 second.
    //
    // Negative would put `veto_ends_at` before `attested_at`, making settle
    // callable before the attestation it finalizes; unbounded-large would
    // strand every redemption behind a settle nobody can ever call.
    require!(
        args.veto_period_secs > 0
            && args.veto_period_secs <= crate::constants::MAX_VETO_PERIOD_SECS,
        SoothCoreError::InvalidVetoPeriod
    );

    let split_total = (args.b_base_share_bps as u32)
        + (args.lp_yield_share_bps as u32)
        + (args.adjudicator_share_bps as u32)
        + (args.protocol_share_bps as u32);
    require!(split_total == 10_000, SoothCoreError::FeeSplitMismatch);

    let cfg = &mut ctx.accounts.config;
    cfg.authority = ctx.accounts.authority.key();
    cfg.treasury = args.treasury;
    cfg.amm_fee_bps = args.amm_fee_bps;
    cfg.book_fee_bps = args.book_fee_bps;
    cfg.b_base_share_bps = args.b_base_share_bps;
    cfg.lp_yield_share_bps = args.lp_yield_share_bps;
    cfg.adjudicator_share_bps = args.adjudicator_share_bps;
    cfg.protocol_share_bps = args.protocol_share_bps;
    cfg.default_trial_period = args.default_trial_period;
    cfg.paused = false;
    cfg.permissionless_adjudicators = args.permissionless_adjudicators;
    cfg.veto_period_secs = args.veto_period_secs;
    cfg.bump = ctx.bumps.config;

    require!(
        cfg.split_total() == 10_000,
        SoothCoreError::FeeSplitMismatch
    );

    let now = Clock::get()?.unix_timestamp;
    emit!(ProtocolInitialized {
        authority: cfg.authority,
        treasury: cfg.treasury,
        amm_fee_bps: cfg.amm_fee_bps,
        book_fee_bps: cfg.book_fee_bps,
        ts: now,
    });

    Ok(())
}
