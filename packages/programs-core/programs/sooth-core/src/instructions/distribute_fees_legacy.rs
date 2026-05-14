//! `distribute_fees_legacy` — one-shot drain for the pre-W5 global fee pool.
//!
//! Adapted from `sooth_launchpad::distribute_fees_legacy`. No changes to logic;
//! `seeds::program` constraints removed, `ProtocolConfig` is now `sooth_core`'s
//! own type, `compute_fee_split` is imported from this crate's
//! `distribute_fees` module.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothCoreError;
use crate::events::FeesCollected;
use crate::instructions::distribute_fees::compute_fee_split;
use crate::state::{LegacyFeeDrainMarker, ProtocolConfig};

#[derive(Accounts)]
pub struct DistributeFeesLegacy<'info> {
    #[account(
        init_if_needed,
        payer = cranker,
        space = LegacyFeeDrainMarker::SPACE,
        seeds = [b"legacy_fee_drain_marker"],
        bump,
    )]
    pub legacy_marker: Box<Account<'info, LegacyFeeDrainMarker>>,

    #[account(
        seeds = [b"protocol_config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: signer-only PDA — authority on the legacy global `fee_pool_vault`.
    #[account(
        seeds = [b"fee_pool_authority"],
        bump,
    )]
    pub fee_pool_authority: UncheckedAccount<'info>,

    #[account(address = crate::constants::BASE_TOKEN_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = fee_pool_authority,
    )]
    pub fee_pool_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = usdc_mint)]
    pub b_base_yield_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = usdc_mint)]
    pub lp_yield_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = usdc_mint)]
    pub adjudicator_fee_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = config.treasury, token::mint = usdc_mint)]
    pub protocol_treasury_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub cranker: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DistributeFeesLegacy>) -> Result<()> {
    let marker = &mut ctx.accounts.legacy_marker;
    require!(
        marker.drained_at == 0,
        SoothCoreError::LegacyDrainAlreadyExecuted
    );

    let total: u64 = ctx.accounts.fee_pool_vault.amount;
    let split = compute_fee_split(total, &ctx.accounts.config)?;

    let bump = ctx.bumps.fee_pool_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[b"fee_pool_authority", &[bump]]];

    if split.to_b_base > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.fee_pool_vault.to_account_info(),
                    to: ctx.accounts.b_base_yield_vault.to_account_info(),
                    authority: ctx.accounts.fee_pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            split.to_b_base,
        )?;
    }
    if split.to_lp_yield > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.fee_pool_vault.to_account_info(),
                    to: ctx.accounts.lp_yield_vault.to_account_info(),
                    authority: ctx.accounts.fee_pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            split.to_lp_yield,
        )?;
    }
    if split.to_adjudicator > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.fee_pool_vault.to_account_info(),
                    to: ctx.accounts.adjudicator_fee_vault.to_account_info(),
                    authority: ctx.accounts.fee_pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            split.to_adjudicator,
        )?;
    }
    if split.to_protocol > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.fee_pool_vault.to_account_info(),
                    to: ctx.accounts.protocol_treasury_vault.to_account_info(),
                    authority: ctx.accounts.fee_pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            split.to_protocol,
        )?;
    }

    let now = Clock::get()?.unix_timestamp;
    marker.drained_at = now;
    marker.bump = ctx.bumps.legacy_marker;

    emit!(FeesCollected {
        market: Pubkey::default(),
        total_wad: total as u128,
        to_b_base: split.to_b_base,
        to_lp_yield: split.to_lp_yield,
        to_adjudicator: split.to_adjudicator,
        to_protocol: split.to_protocol,
        ts: now,
    });

    Ok(())
}
