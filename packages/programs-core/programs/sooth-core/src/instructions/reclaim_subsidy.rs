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
//! ## Dismissal, and the obligation that gates it
//!
//! A dismissed market refunds every position at COST — `Position
//! .locked_cost_usdc` — and that pot is not self-funding. Writing `net_i` for
//! a position's buys minus its sell proceeds, the vault holds
//! `seed + Σ net_i` while refunds owe `Σ max(net_i, 0)`, because a position
//! that exited at a profit floors at zero instead of going negative. The
//! difference is exactly `seed − P`, where `P` is the profit already
//! withdrawn by traders who round-tripped before the dismissal. The creator's
//! subsidy IS the collateral for those refunds, so it must not leave while
//! one is outstanding.
//!
//! `AmmState.refund_obligation_usdc` is that outstanding total, maintained by
//! every path that moves a `locked_cost_usdc`. So a dismissed market's
//! subsidy is reclaimable exactly when the counter reads zero — every refund
//! claimed or extinguished — and not before.
//!
//! The counter reads zero on accounts written before it existed, and zero is
//! the direction that pays out: it would report "nothing owed" for a market
//! whose every refund is still unclaimed. `AmmState.tracks_refund_obligation`
//! separates the two — set by `create_market`, clear on every legacy account
//! — and a dismissed market whose counter is untracked is refused exactly as
//! it was before the counter existed. Its subsidy stays stranded and
//! `close_market` cannot run on it; that is the honest cost of not being able
//! to reconstruct `P` for a market nobody was counting.
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

/// May the subsidy leave? Settlement and dismissal are the two terminal
/// states, and each has its own arithmetic.
///
/// Settlement: the residual is what the share ledger no longer owes, so the
/// lifecycle check is the whole precondition.
///
/// Dismissal: refunds are owed at cost out of this same vault, so the subsidy
/// leaves only once the refund total is zero — and only when the counter is
/// one this market has kept from birth. See the module docs.
fn assert_reclaimable(market: &Market, amm: &AmmState) -> Result<()> {
    if market.is_settled() {
        return Ok(());
    }
    require!(amm.is_dismissed, SoothCoreError::MarketNotSettled);
    require!(
        amm.tracks_refund_obligation,
        SoothCoreError::MarketNotSettled
    );
    require!(
        amm.refund_obligation_usdc == 0,
        SoothCoreError::RefundsOutstanding
    );
    Ok(())
}

pub fn handler(ctx: Context<ReclaimSubsidy>) -> Result<()> {
    assert_reclaimable(&ctx.accounts.market, &ctx.accounts.amm_state)?;

    // A dismissed market pays no settlement claims, and its refund total is
    // already zero by the guard above — so the share ledger owes nothing and
    // `winning_outcome` is meaningless on it. Reading the field anyway would
    // hand `ledger_obligations` an outcome nothing ever wrote.
    let winning_outcome = ctx.accounts.market.winning_outcome;

    let ledger_owed = if ctx.accounts.market.is_settled() {
        ledger_obligations(&ctx.accounts.amm_state, winning_outcome)?
    } else {
        0
    };

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::amm_state::{amm_fixture, legacy_amm_fixture};
    use crate::state::market::market_fixture;
    use crate::state::MarketLifecycle;

    fn dismissed() -> (Market, AmmState) {
        let mut market = market_fixture(MarketLifecycle::Open);
        let mut amm = amm_fixture();
        market.is_dismissed = true;
        amm.is_dismissed = true;
        (market, amm)
    }

    #[test]
    fn a_settled_market_reclaims() {
        let market = market_fixture(MarketLifecycle::Settled);
        assert!(assert_reclaimable(&market, &amm_fixture()).is_ok());
    }

    #[test]
    fn a_live_market_reclaims_nothing() {
        let market = market_fixture(MarketLifecycle::Open);
        assert!(assert_reclaimable(&market, &amm_fixture()).is_err());
    }

    #[test]
    fn a_dismissed_market_holds_the_subsidy_while_a_refund_stands() {
        // The subsidy IS the collateral behind refunds-at-cost. Returning it
        // with claims outstanding is what makes the last claimant unpayable.
        let (market, mut amm) = dismissed();
        amm.refund_obligation_usdc = 1;
        assert!(assert_reclaimable(&market, &amm).is_err());
    }

    #[test]
    fn a_dismissed_market_releases_the_subsidy_once_every_refund_is_settled() {
        // The counter reaching zero means every claim was paid or
        // extinguished, so the vault owes nobody and the creator's own capital
        // stops being stranded.
        let (market, amm) = dismissed();
        assert_eq!(amm.refund_obligation_usdc, 0);
        assert!(assert_reclaimable(&market, &amm).is_ok());
    }

    #[test]
    fn a_legacy_dismissed_market_never_releases_the_subsidy() {
        // Its counter reads zero because nothing ever counted, not because
        // nothing is owed — and zero is the direction that pays out. Refused
        // exactly as it was before the counter existed.
        let (market, mut amm) = dismissed();
        let legacy = legacy_amm_fixture();
        amm.tracks_refund_obligation = legacy.tracks_refund_obligation;
        amm.refund_obligation_usdc = 0;
        assert!(assert_reclaimable(&market, &amm).is_err());
    }

    #[test]
    fn a_dismissed_market_owes_nothing_on_the_share_ledger() {
        // Dismissal pays at cost, never per share, so the shares still
        // recorded in `q` back no claim. Counting them would strand the
        // creator's capital behind an obligation that cannot be redeemed.
        let (_, mut amm) = dismissed();
        amm.q_yes = 10_000;
        amm.q_no = 4_000;
        assert!(assert_reclaimable(&market_fixture(MarketLifecycle::Settled), &amm).is_ok());
    }
}
