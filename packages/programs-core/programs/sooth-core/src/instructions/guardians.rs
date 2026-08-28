//! Guardian roster management — `guardian_add` / `guardian_remove`.
//!
//! Both are signed by the entry's `dispute_authority`: the key that holds the
//! veto today is the key that may share it. `guardian_add` lazily creates the
//! set (init_if_needed), so markets that never deputize anyone never pay the
//! rent.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::{GuardianAdded, GuardianRemoved};
use crate::state::{
    AdjudicatorEntry, GuardianSet, GuardianSetError, ADJUDICATOR_ENTRY_SEED, GUARDIAN_SET_SEED,
};

fn map_set_err(e: GuardianSetError) -> anchor_lang::error::Error {
    match e {
        GuardianSetError::AlreadyPresent => error!(SoothCoreError::GuardianAlreadyPresent),
        GuardianSetError::Full => error!(SoothCoreError::GuardianSetFull),
        GuardianSetError::NotFound => error!(SoothCoreError::GuardianNotFound),
    }
}

#[derive(Accounts)]
pub struct GuardianAdd<'info> {
    #[account(
        seeds = [ADJUDICATOR_ENTRY_SEED, adjudicator_entry.market.as_ref()],
        bump = adjudicator_entry.bump,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    #[account(
        init_if_needed,
        payer = authority,
        space = GuardianSet::SIZE,
        seeds = [GUARDIAN_SET_SEED, adjudicator_entry.market.as_ref()],
        bump,
    )]
    pub guardian_set: Account<'info, GuardianSet>,

    #[account(
        mut,
        constraint = authority.key() == adjudicator_entry.dispute_authority
            @ SoothCoreError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn guardian_add(ctx: Context<GuardianAdd>, guardian: Pubkey) -> Result<()> {
    require!(
        guardian != Pubkey::default(),
        SoothCoreError::InvalidOutcome
    );
    let set = &mut ctx.accounts.guardian_set;
    if set.market == Pubkey::default() {
        set.market = ctx.accounts.adjudicator_entry.market;
        set.bump = ctx.bumps.guardian_set;
    }
    set.add(guardian).map_err(map_set_err)?;
    emit!(GuardianAdded {
        market: set.market,
        guardian,
        count: set.count,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct GuardianRemove<'info> {
    #[account(
        seeds = [ADJUDICATOR_ENTRY_SEED, adjudicator_entry.market.as_ref()],
        bump = adjudicator_entry.bump,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    #[account(
        mut,
        seeds = [GUARDIAN_SET_SEED, adjudicator_entry.market.as_ref()],
        bump = guardian_set.bump,
    )]
    pub guardian_set: Account<'info, GuardianSet>,

    #[account(
        constraint = authority.key() == adjudicator_entry.dispute_authority
            @ SoothCoreError::Unauthorized,
    )]
    pub authority: Signer<'info>,
}

pub fn guardian_remove(ctx: Context<GuardianRemove>, guardian: Pubkey) -> Result<()> {
    let set = &mut ctx.accounts.guardian_set;
    set.remove(&guardian).map_err(map_set_err)?;
    emit!(GuardianRemoved {
        market: set.market,
        guardian,
        count: set.count,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
