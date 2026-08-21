//! `register_zk_adjudicator` — create a per-market `AdjudicatorEntry` that
//! resolves from a Primus zkTLS attestation instead of a human signature.
//!
//! Deliberately a separate instruction from `register_adjudicator` rather than
//! an optional argument on it: the manual path's account layout, auth rules
//! and event stay byte-identical, and zk mode is a property fixed at creation
//! rather than something that can be switched on under a market that is
//! already trading.
//!
//! The `authority` still matters. It is the `dispute_authority`, so the
//! guardian veto remains available even though nothing human attests.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::events::ZkAdjudicatorRegistered;
use crate::state::{AdjudicatorEntry, Market, ProtocolConfig, ADJUDICATOR_ENTRY_SEED};
use crate::zk::{EvmAddress, ZkComparator, MAX_ZK_VALUE_SCALE};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RegisterZkAdjudicatorArgs {
    /// Gates `dispute`. Not an attestation authority: nothing about
    /// `attest_outcome_zk` is signer-gated.
    pub authority: Pubkey,
    /// The one EVM address whose attestations this market accepts.
    pub attestor_evm: EvmAddress,
    /// `crate::zk::compute_rule_hash(url, parse_path)`, computed off-chain by
    /// whoever picks the endpoint and re-derived on-chain from the submitted
    /// attestation.
    pub rule_hash: [u8; 32],
    /// `ZkComparator` discriminant. `None` (0) is rejected — registering a
    /// zk entry that can never resolve is always a mistake.
    pub comparator: u8,
    /// Threshold in `10^value_scale` units.
    pub threshold: i64,
    pub value_scale: u8,
}

#[derive(Accounts)]
pub struct RegisterZkAdjudicator<'info> {
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

pub fn handler(ctx: Context<RegisterZkAdjudicator>, args: RegisterZkAdjudicatorArgs) -> Result<()> {
    // Same gate as the manual path: permissioned mode restricts registration
    // to the protocol authority, permissionless mode to the market creator.
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
        args.authority,
        Pubkey::default(),
        SoothCoreError::AdjudicatorIsDefault
    );

    let comparator = ZkComparator::from_u8(args.comparator)?;
    require!(
        comparator != ZkComparator::None,
        SoothCoreError::ZkInvalidComparator
    );
    require!(
        args.value_scale <= MAX_ZK_VALUE_SCALE,
        SoothCoreError::ZkInvalidValueScale
    );
    // The zero address is what an unset `zk_attestor_evm` looks like, and no
    // key recovers to it, so accepting it would create an entry that can
    // never resolve.
    require!(
        args.attestor_evm != [0u8; 20],
        SoothCoreError::ZkAttestorMismatch
    );
    require!(
        args.rule_hash != [0u8; 32],
        SoothCoreError::ZkRuleHashMismatch
    );

    let market_key = ctx.accounts.market.key();

    let entry = &mut ctx.accounts.adjudicator_entry;
    entry.market = market_key;
    // No human attests, so there is no attestation authority. The field is
    // kept non-default to preserve the invariant the manual path relies on,
    // and pointed at the same key that holds the veto.
    entry.authority = args.authority;
    entry.dispute_authority = args.authority;
    entry.attested_outcome = None;
    entry.attested_at = None;
    entry.disputed = false;
    entry.disputed_at = None;
    entry.bump = ctx.bumps.adjudicator_entry;
    entry.zk_comparator = args.comparator;
    entry.zk_value_scale = args.value_scale;
    entry.zk_attestor_evm = args.attestor_evm;
    entry.zk_rule_hash = args.rule_hash;
    entry.zk_threshold = args.threshold;
    entry.forced_invalid = false;
    entry._reserved = [0u8; 1];

    let now = Clock::get()?.unix_timestamp;
    emit!(ZkAdjudicatorRegistered {
        market: market_key,
        adjudicator_entry: entry.key(),
        authority: args.authority,
        attestor_evm: args.attestor_evm,
        rule_hash: args.rule_hash,
        comparator: args.comparator,
        threshold: args.threshold,
        value_scale: args.value_scale,
        ts: now,
    });

    Ok(())
}
