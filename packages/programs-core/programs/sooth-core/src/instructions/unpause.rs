//! `unpause` — clear the protocol circuit-breaker (`ProtocolConfig.paused = false`).
//!
//! Auth: `config.authority` must sign.
//! Idempotent (no error if already unpaused).

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::ProtocolPausedEvent;
use crate::state::ProtocolConfig;

#[derive(Accounts)]
pub struct Unpause<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = config.bump,
        constraint = config.authority == authority.key() @ SoothCoreError::Unauthorized,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<Unpause>) -> Result<()> {
    ctx.accounts.config.paused = false;
    let now = Clock::get()?.unix_timestamp;
    emit!(ProtocolPausedEvent {
        authority: ctx.accounts.authority.key(),
        paused: false,
        ts: now,
    });
    Ok(())
}
