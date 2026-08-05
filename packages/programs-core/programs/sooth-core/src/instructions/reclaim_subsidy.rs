//! `reclaim_subsidy` — return the unspent LMSR subsidy to the creator after
//! settlement. (Bug B0, residual half.)
//!
//! ## Why this could not be written until now
//!
//! `seed_lp` requires the creator to post `b·ln(2)` into the market vault. That
//! is the maximum the LMSR can ever lose, not what it *will* lose: fees repay
//! it as the market trades, and a market that never moves much gives most of it
//! back. Until this instruction there was no way to give any of it back — it
//! sat in the vault forever.
//!
//! Paying it out safely means knowing everything the vault still owes, and an
//! UNDER-count is an over-payment taken out of traders' collateral. Three
//! ledgers hold obligations:
//!
//!   1. SPL outcome tokens — `yes_mint.supply` / `no_mint.supply`;
//!   2. AMM positions — aggregated in `AmmState.q_yes` / `q_no`;
//!   3. the book — seats and resting escrow, all in one account.
//!
//! The blocker was a *fourth*: the legacy `OrderbookPosition` was one PDA per
//! (market, user) and no instruction could enumerate them, so the sum was
//! unknowable. Deleting the legacy book removed that ledger, and every
//! remaining source is a single account away.
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
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::book::account::load_book;
use crate::constants::BASE_TOKEN_MINT;
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

    /// CHECK: raw zero-copy book; `load_book` verifies it and the seeds bind it
    /// to this market. Read-only here.
    #[account(seeds = [b"book", market.market_id.as_ref()], bump)]
    pub book: UncheckedAccount<'info>,

    #[account(
        seeds = [b"yes_mint", market.market_id.as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [b"no_mint", market.market_id.as_ref()],
        bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    /// CHECK: derived via seeds; signs the vault outflow.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault @ SoothCoreError::VaultAuthorityMismatch,
        constraint = vault.mint == BASE_TOKEN_MINT
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault.mint, token::authority = creator)]
    pub creator_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

/// Shares still owed one unit each, from the AMM and the SPL token supply.
///
/// `q_yes` includes `seed_q_yes`, the virtual inventory the subsidy bought.
/// Nobody holds those, so counting them would understate the residual — the
/// safe direction, but it would strand the creator's money, which is the whole
/// bug. Subtract them, saturating: a negative would mean state corruption, and
/// treating it as zero over-counts obligations rather than under-counting.
fn ledger_obligations(
    amm: &AmmState,
    yes_supply: u64,
    no_supply: u64,
    winning_outcome: u8,
) -> Result<u64> {
    let user_q_yes = amm.q_yes.saturating_sub(amm.seed_q_yes).max(0) as u128;
    let user_q_no = amm.q_no.saturating_sub(amm.seed_q_no).max(0) as u128;

    let amm_yes = wad_to_base(user_q_yes)?;
    let amm_no = wad_to_base(user_q_no)?;

    let (yes_total, no_total) = (
        amm_yes
            .checked_add(yes_supply)
            .ok_or(error!(SoothCoreError::MathOverflow))?,
        amm_no
            .checked_add(no_supply)
            .ok_or(error!(SoothCoreError::MathOverflow))?,
    );

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

    let book_owed = {
        let info = ctx.accounts.book.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        let book =
            load_book(&mut data).map_err(|_| error!(SoothCoreError::InvalidBookAccount))?;
        book.total_obligations(winning_outcome)
            .map_err(|_| error!(SoothCoreError::InvalidBookAccount))?
    };

    let ledger_owed = ledger_obligations(
        &ctx.accounts.amm_state,
        ctx.accounts.yes_mint.supply,
        ctx.accounts.no_mint.supply,
        winning_outcome,
    )?;

    let obligations = book_owed
        .checked_add(ledger_owed)
        .ok_or(error!(SoothCoreError::MathOverflow))?;

    // Everything above what is owed. Saturating: a vault below its obligations
    // means there is nothing free, not a negative to invert.
    let residual = ctx.accounts.vault.amount.saturating_sub(obligations);

    // The cap. Whatever the residual says, never return more than was posted.
    let posted = wad_to_base(ctx.accounts.lp_position.seed_deposit_wad)?;
    let remaining = posted.saturating_sub(ctx.accounts.lp_position.reclaimed_base);
    let payout = residual.min(remaining);

    // Nothing free yet, or the cap is spent. Failing rather than succeeding
    // with a zero transfer tells the creator which it was via the logs above.
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
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.creator_usdc_ata.to_account_info(),
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
