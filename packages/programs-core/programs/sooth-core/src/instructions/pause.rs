//! `pause` — set the protocol circuit-breaker (`ProtocolConfig.paused = true`).
//!
//! Auth: `config.authority` must sign. Permissionless callers are rejected.
//! Idempotent (no error if already paused).

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::ProtocolPausedEvent;
use crate::state::ProtocolConfig;

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = config.bump,
        constraint = config.authority == authority.key() @ SoothCoreError::Unauthorized,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<Pause>) -> Result<()> {
    ctx.accounts.config.paused = true;
    let now = Clock::get()?.unix_timestamp;
    emit!(ProtocolPausedEvent {
        authority: ctx.accounts.authority.key(),
        paused: true,
        ts: now,
    });
    Ok(())
}
