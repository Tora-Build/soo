//! `add_adjudicator` — appends a pubkey to the singleton adjudicator-allowlist.
//!
//! See `state/adjudicator_allowlist.rs`. Errors:
//!   - `AllowlistAuthorityMismatch` if the signer is not the recorded authority
//!   - `AllowlistFull` if all 16 slots are populated
//!   - `AdjudicatorAlreadyAllowlisted` if the pubkey is already present (idempotency
//!     here is *not* a silent no-op — duplicate adds are a likely operator
//!     mistake worth surfacing)

use anchor_lang::prelude::*;

use crate::error::SoothMarketError;
use crate::state::{
    AdjudicatorAllowlist, ADJUDICATOR_ALLOWLIST_CAPACITY, ADJUDICATOR_ALLOWLIST_SEED,
};

#[derive(Accounts)]
pub struct AddAdjudicator<'info> {
    #[account(
        mut,
        seeds = [ADJUDICATOR_ALLOWLIST_SEED],
        bump = allowlist.bump,
    )]
    pub allowlist: Account<'info, AdjudicatorAllowlist>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<AddAdjudicator>, adjudicator: Pubkey) -> Result<()> {
    let allowlist = &mut ctx.accounts.allowlist;

    require_keys_eq!(
        ctx.accounts.authority.key(),
        allowlist.authority,
        SoothMarketError::AllowlistAuthorityMismatch
    );

    let count = allowlist.entry_count as usize;
    require!(
        count < ADJUDICATOR_ALLOWLIST_CAPACITY,
        SoothMarketError::AllowlistFull
    );
    require!(
        !allowlist.contains(adjudicator),
        SoothMarketError::AdjudicatorAlreadyAllowlisted
    );

    allowlist.entries[count] = adjudicator;
    allowlist.entry_count = (count as u8) + 1;
    Ok(())
}
