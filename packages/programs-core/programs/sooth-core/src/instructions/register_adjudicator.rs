//! `register_adjudicator` — create the per-market `AdjudicatorEntry` PDA.
//!
//! v1 auth: `signer.key() == market.creator`.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::AdjudicatorRegistered;
use crate::state::{AdjudicatorEntry, Market, ProtocolConfig, ADJUDICATOR_ENTRY_SEED};

#[derive(Accounts)]
pub struct RegisterAdjudicator<'info> {
    /// New per-market `AdjudicatorEntry` PDA.
    #[account(
        init,
        payer = signer,
        space = AdjudicatorEntry::SPACE,
        seeds = [ADJUDICATOR_ENTRY_SEED, market.key().as_ref()],
        bump,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RegisterAdjudicator>, authority: Pubkey) -> Result<()> {
    // Permissioned mode: only config.authority may register adjudicators.
    // Permissionless mode: any market creator may register.
    if ctx.accounts.protocol_config.permissionless_adjudicators {
        require_keys_eq!(
            ctx.accounts.signer.key(),
            ctx.accounts.market.creator,
            SoothCoreError::Unauthorized
        );
    } else {
        require_keys_eq!(
            ctx.accounts.signer.key(),
            ctx.accounts.protocol_config.authority,
            SoothCoreError::Unauthorized
        );
    }

    require_keys_neq!(
        authority,
        Pubkey::default(),
        SoothCoreError::AdjudicatorIsDefault
    );

    let market_key = ctx.accounts.market.key();

    let entry = &mut ctx.accounts.adjudicator_entry;
    entry.market = market_key;
    entry.authority = authority;
    entry.dispute_authority = authority; // v1 collapsed: same as attestation authority
    entry.attested_outcome = None;
    entry.attested_at = None;
    entry.disputed = false;
    entry.disputed_at = None;
    entry.bump = ctx.bumps.adjudicator_entry;

    let now = Clock::get()?.unix_timestamp;
    emit!(AdjudicatorRegistered {
        market: market_key,
        adjudicator_entry: entry.key(),
        authority,
        ts: now,
    });

    Ok(())
}
