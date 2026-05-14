//! `initialize_protocol` — singleton init for the cluster's `ProtocolConfig`.
//!
//! Adapted from `sooth_launchpad::initialize_protocol`.
//! Adds `paused: false` initialization for the circuit-breaker field.
//! All other logic is verbatim.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::ProtocolInitialized;
use crate::state::{protocol_config::MAX_FEE_BPS, ProtocolConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeProtocolArgs {
    pub fee_bps: u16,
    pub treasury: Pubkey,
    pub b_base_share_bps: u16,
    pub lp_yield_share_bps: u16,
    pub adjudicator_share_bps: u16,
    pub protocol_share_bps: u16,
    pub default_trial_period: i64,
    pub permissionless_adjudicators: bool,
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
        args.fee_bps <= MAX_FEE_BPS,
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

    let split_total = (args.b_base_share_bps as u32)
        + (args.lp_yield_share_bps as u32)
        + (args.adjudicator_share_bps as u32)
        + (args.protocol_share_bps as u32);
    require!(split_total == 10_000, SoothCoreError::FeeSplitMismatch);

    let cfg = &mut ctx.accounts.config;
    cfg.authority = ctx.accounts.authority.key();
    cfg.treasury = args.treasury;
    cfg.fee_bps = args.fee_bps;
    cfg.b_base_share_bps = args.b_base_share_bps;
    cfg.lp_yield_share_bps = args.lp_yield_share_bps;
    cfg.adjudicator_share_bps = args.adjudicator_share_bps;
    cfg.protocol_share_bps = args.protocol_share_bps;
    cfg.default_trial_period = args.default_trial_period;
    cfg.paused = false;
    cfg.permissionless_adjudicators = args.permissionless_adjudicators;
    cfg.bump = ctx.bumps.config;

    require!(
        cfg.split_total() == 10_000,
        SoothCoreError::FeeSplitMismatch
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
