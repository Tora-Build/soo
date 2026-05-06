//! `distribute_fees` — STUB. Drains `AmmState.fee_b_base_wad` and routes the
//! proceeds across the four destinations per architecture §8.
//!
//! EVM analogue: `FeeRouter._distribute` (`FeeRouter.sol:380-410`). On Solana
//! this is **inlined inside `sooth_launchpad`** rather than a separate
//! program — see the §1 / §8 rationale in `lib.rs`.
//!
//! ## Status
//!
//! Body is `todo!()`. The accounts struct is committed so the IDL shape is
//! stable.
//!
//! ## Body when it lands (arch §8)
//!
//! 1. Read `total_wad = amm_state.fee_b_base_wad`. Require > 0.
//! 2. Read split bps from `config`. Compute four slice amounts:
//!      `to_b_base       = total * b_base_share_bps       / 10_000`
//!      `to_lp_yield     = total * lp_yield_share_bps     / 10_000`
//!      `to_adjudicator  = total * adjudicator_share_bps  / 10_000`
//!      `to_protocol     = total * protocol_share_bps     / 10_000`
//!    Account dust by routing the remainder (`total - sum_of_four`) to the
//!    protocol slice — matches the EVM `FeeRouter` rounding convention.
//! 3. Convert each WAD slice to USDC base units via `wad_to_usdc_floor`.
//! 4. Four CPI `token::transfer` calls, signed by `vault_authority` PDA:
//!      vault → bBase ATA, vault → lp_yield ATA,
//!      vault → adjudicator_fee ATA, vault → treasury ATA.
//! 5. Zero out `amm_state.fee_b_base_wad`.
//! 6. emit!(FeesCollected { … }).

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use sooth_amm::state::AmmState;
use sooth_market::state::Market;

use crate::state::ProtocolConfig;

#[derive(Accounts)]
pub struct DistributeFees<'info> {
    #[account(
        seeds = [b"protocol_config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    /// Market PDA — owned by `sooth_market`. Read-only here; we use it to
    /// derive the vault-authority signer seeds.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Box<Account<'info, Market>>,

    /// AmmState PDA — owned by `sooth_amm`. Mutated to zero-out the fee
    /// accumulator after distribution.
    #[account(
        mut,
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        seeds::program = sooth_amm::ID,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// CHECK: signer-only PDA derived via seeds. Authority for the four
    /// `token::transfer` CPIs out of the market's USDC vault.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
        seeds::program = sooth_market::ID,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// USDC vault for this market. Source of all four transfers.
    #[account(mut, address = market.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// Pre-graduation: bBase fee accumulator destination. ATA owned by
    /// `protocol_config` PDA in v1 (re-injected back into `b` on
    /// graduation; see arch §8 footnote).
    #[account(mut, token::mint = vault.mint)]
    pub b_base_yield_vault: Box<Account<'info, TokenAccount>>,

    /// LP-yield ATA. Owned by the LP-yield PDA (out of scope here; the
    /// owner check is enforced when `seed_lp` lands and binds the PDA).
    #[account(mut, token::mint = vault.mint)]
    pub lp_yield_vault: Box<Account<'info, TokenAccount>>,

    /// Adjudicator-fee ATA. Owner pubkey is on `Market.adjudicator` in EVM
    /// (`market.adjudicator_fee_dest` in arch §8). The Anchor `address`
    /// constraint will pin this once we add the corresponding field to
    /// `Market`. For the scaffold, just shape-bind it.
    #[account(mut, token::mint = vault.mint)]
    pub adjudicator_fee_vault: Box<Account<'info, TokenAccount>>,

    /// Protocol treasury ATA. Pinned to `config.treasury`.
    #[account(mut, address = config.treasury, token::mint = vault.mint)]
    pub protocol_treasury_vault: Box<Account<'info, TokenAccount>>,

    /// Anyone can crank fee distribution — it's a pure split with no
    /// authority gate. (EVM `FeeRouter._distribute` is `external` and
    /// permissionless.)
    pub cranker: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[allow(unused_variables)]
pub fn handler(_ctx: Context<DistributeFees>) -> Result<()> {
    // See module comment for the full spec when this lands. Architecture §8.
    todo!("fee router 4-way split + 4 token::transfer CPIs signed by vault_authority; see architecture §8")
}
