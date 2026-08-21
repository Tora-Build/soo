//! `reclaim_subsidy` — return the unspent LMSR subsidy to the creator after
//! settlement.
//!
//! ## What this returns
//!
//! `seed_lp` requires the creator to post `b·ln(2)` into the market vault. That
//! is the maximum the LMSR can ever lose, not what it *will* lose: fees repay
//! it as the market trades, and a market that never moves much gives most of it
//! back. This instruction is the only path that returns the unspent portion.
//!
//! Paying it out safely means knowing everything the vault still owes, and an
//! UNDER-count is an over-payment taken out of traders' collateral.
//!
//! There is exactly **one** ledger to count: AMM positions, aggregated in
//! `AmmState.q_yes` / `q_no`. The subsidy is posted in the AMM token and is
//! returned from the AMM vault, so the book — a different vault holding a
//! different mint — is not this instruction's business. Counting its seats
//! here would subtract book obligations from the AMM residual and strand the
//! creator's capital.
//!
//! ## The two guards
//!
//! **Residual.** Pay only `vault - obligations`. If the arithmetic is right,
//! that money is owed to nobody.
//!
//! **Cap.** Never pay more than the subsidy actually posted, less what has
//! already been reclaimed. This is defence in depth, and it is what bounds the
//! damage of a mistake: an under-counted obligation can, at worst, hand back
//! the creator's own capital early. It can never reach into trading profits.
//!
//! ## Why it is callable repeatedly
//!
//! Obligations shrink as traders redeem, so the free residual grows over time.
//! A single-shot instruction would force the creator to guess when to fire it,
//! and guessing early means leaving their own money behind permanently.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::AMM_TOKEN_MINT;
use crate::error::SoothCoreError;
use crate::math::wad_to_base;
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::{AmmState, LpPosition, Market};

#[derive(Accounts)]
pub struct ReclaimSubsidy<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        has_one = market @ SoothCoreError::Unauthorized,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    #[account(
        mut,
        seeds = [b"lp_position", market.market_id.as_ref(), creator.key().as_ref()],
        bump = lp_position.bump,
        has_one = market @ SoothCoreError::Unauthorized,
        has_one = creator @ SoothCoreError::Unauthorized,
    )]
    pub lp_position: Box<Account<'info, LpPosition>>,

    /// CHECK: derived via seeds; signs the vault outflow.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// The AMM vault, and only the AMM vault.
    ///
    /// The subsidy was posted in the AMM token by `seed_lp`, so it is returned
    /// from the same pot. The book's vault holds a different mint and cannot
    /// be touched here even by mistake — an SPL token account holds one mint,
    /// and `address` pins which account this is.
    #[account(
        mut,
        address = market.vault_amm @ SoothCoreError::VaultAuthorityMismatch,
        constraint = vault_amm.mint == AMM_TOKEN_MINT
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub vault_amm: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault_amm.mint, token::authority = creator)]
    pub creator_amm_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

/// Shares still owed one unit each, from the AMM.
///
/// `q_yes` includes `seed_q_yes`, the virtual inventory the subsidy bought.
/// Nobody holds those, so counting them would understate the residual — the
/// safe direction, but it would strand the creator's money.
/// Subtract them, saturating: a negative would mean state corruption, and
/// treating it as zero over-counts obligations rather than under-counting.
fn ledger_obligations(amm: &AmmState, winning_outcome: u8) -> Result<u64> {
    let user_q_yes = amm.q_yes.saturating_sub(amm.seed_q_yes).max(0) as u128;
    let user_q_no = amm.q_no.saturating_sub(amm.seed_q_no).max(0) as u128;

    let (yes_total, no_total) = (wad_to_base(user_q_yes)?, wad_to_base(user_q_no)?);

    Ok(match winning_outcome {
        OUTCOME_YES => yes_total,
        OUTCOME_NO => no_total,
        // Both sides are worth half, so the pair together is worth one whole
        // unit per matched share — the same total, split differently.
        OUTCOME_INVALID => yes_total / 2 + no_total / 2,
        _ => return err!(SoothCoreError::InvalidOutcome),
    })
}

pub fn handler(ctx: Context<ReclaimSubsidy>) -> Result<()> {
    require!(
        ctx.accounts.market.is_settled(),
        SoothCoreError::MarketNotSettled
    );

    let winning_outcome = ctx.accounts.market.winning_outcome;

    let ledger_owed = ledger_obligations(&ctx.accounts.amm_state, winning_outcome)?;

    // AMM obligations only. The book's seats are owed from the BOOK vault,
    // which holds a different token, and every book fill escrows both legs to
    // exactly 1.00 — so that vault is fully collateralised by construction and
    // the creator posted nothing into it.
    let obligations = ledger_owed;

    // Everything above what is owed. Saturating: a vault below its obligations
    // means there is nothing free, not a negative to invert.
    let residual = ctx.accounts.vault_amm.amount.saturating_sub(obligations);

    // The cap. Whatever the residual says, never return more than was posted.
    let posted = wad_to_base(ctx.accounts.lp_position.seed_deposit_wad)?;
    let remaining = posted.saturating_sub(ctx.accounts.lp_position.reclaimed_base);
    let payout = residual.min(remaining);

    // Nothing free yet, or the cap is spent. Failing rather than succeeding
    // with a zero transfer keeps a no-op call distinguishable from a payout.
    require!(payout > 0, SoothCoreError::ZeroAmount);

    // Book before transfer, so a re-entrant call finds the cap already spent.
    ctx.accounts.lp_position.reclaimed_base = ctx
        .accounts
        .lp_position
        .reclaimed_base
        .checked_add(payout)
        .ok_or(error!(SoothCoreError::MathOverflow))?;

    let market_id = ctx.accounts.market.market_id;
    let bump = ctx.accounts.market.vault_authority_bump;
    let seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[bump]]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_amm.to_account_info(),
                to: ctx.accounts.creator_amm_ata.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            seeds,
        ),
        payout,
    )?;

    msg!(
        "reclaim_subsidy: paid {} (obligations {}, posted {}, reclaimed to date {})",
        payout,
        obligations,
        posted,
        ctx.accounts.lp_position.reclaimed_base,
    );

    Ok(())
}
