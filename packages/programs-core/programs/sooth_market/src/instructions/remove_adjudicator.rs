//! `remove_adjudicator` — removes a pubkey from the singleton allowlist by
//! swap-with-last to keep the populated prefix dense.
//!
//! See `state/adjudicator_allowlist.rs`. Errors:
//!   - `AllowlistAuthorityMismatch` if the signer is not the recorded authority
//!   - `AdjudicatorNotPresent` if the pubkey is not currently allow-listed
//!
//! Note: previously-issued markets that were initialized while a now-removed
//! adjudicator was on the list keep their `market.adjudicator` field (the
//! allowlist is checked at `initialize_market` time only — this is by design
//! for the minimum-viable mitigation). Operationally that means removing an
//! entry only blocks *new* markets from naming that adjudicator; in-flight
//! markets remain settleable by whoever holds the matching key. If/when the
//! threat model demands revocation of in-flight markets, that's the trigger
//! to escalate to the full `sooth_adjudicator` program scaffold.

use anchor_lang::prelude::*;

use crate::error::SoothMarketError;
use crate::state::{AdjudicatorAllowlist, ADJUDICATOR_ALLOWLIST_SEED};

#[derive(Accounts)]
pub struct RemoveAdjudicator<'info> {
    #[account(
        mut,
        seeds = [ADJUDICATOR_ALLOWLIST_SEED],
        bump = allowlist.bump,
    )]
    pub allowlist: Account<'info, AdjudicatorAllowlist>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<RemoveAdjudicator>, adjudicator: Pubkey) -> Result<()> {
    let allowlist = &mut ctx.accounts.allowlist;

    require_keys_eq!(
        ctx.accounts.authority.key(),
        allowlist.authority,
        SoothMarketError::AllowlistAuthorityMismatch
    );

    let count = allowlist.entry_count as usize;
    let mut found_index: Option<usize> = None;
    for (i, key) in allowlist.entries[..count].iter().enumerate() {
        if *key == adjudicator {
            found_index = Some(i);
            break;
        }
    }
    let idx = found_index.ok_or(SoothMarketError::AdjudicatorNotPresent)?;

    // Swap-with-last to keep the populated prefix dense without copying the
    // tail. Then zero the now-vacant last slot so dropped pubkeys never
    // remain in account data.
    let last = count - 1;
    allowlist.entries[idx] = allowlist.entries[last];
    allowlist.entries[last] = Pubkey::default();
    allowlist.entry_count = last as u8;
    Ok(())
}
