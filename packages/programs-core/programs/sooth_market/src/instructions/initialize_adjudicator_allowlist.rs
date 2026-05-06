//! `initialize_adjudicator_allowlist` — one-shot bootstrap for the singleton
//! adjudicator-allowlist PDA.
//!
//! See `state/adjudicator_allowlist.rs` for the rationale (Codex C2 minimum-
//! viable mitigation). This ix MUST be called exactly once per program
//! deployment, before any `initialize_market` call — otherwise market
//! creation will fail account-resolution because the allowlist PDA does not
//! exist. Idempotency via `init_if_needed` is deliberately not used: re-
//! initialising would silently rotate the authority.

use anchor_lang::prelude::*;

use crate::state::{
    AdjudicatorAllowlist, ADJUDICATOR_ALLOWLIST_CAPACITY, ADJUDICATOR_ALLOWLIST_SEED,
};

#[derive(Accounts)]
pub struct InitializeAdjudicatorAllowlist<'info> {
    /// New singleton allowlist PDA. `init` (not `init_if_needed`) — re-init
    /// must be impossible.
    #[account(
        init,
        payer = signer,
        space = AdjudicatorAllowlist::SPACE,
        seeds = [ADJUDICATOR_ALLOWLIST_SEED],
        bump,
    )]
    pub allowlist: Account<'info, AdjudicatorAllowlist>,

    /// Pays the rent-exempt deposit for the allowlist account. Note: this is
    /// distinct from the `authority` arg — typically a deployer wallet pays
    /// rent while the multisig governance key is recorded as the authority.
    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeAdjudicatorAllowlist>, authority: Pubkey) -> Result<()> {
    let allowlist = &mut ctx.accounts.allowlist;
    allowlist.authority = authority;
    allowlist.entries = [Pubkey::default(); ADJUDICATOR_ALLOWLIST_CAPACITY];
    allowlist.entry_count = 0;
    allowlist.bump = ctx.bumps.allowlist;
    Ok(())
}
