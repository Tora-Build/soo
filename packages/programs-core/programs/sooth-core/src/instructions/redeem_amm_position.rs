//! `redeem_amm_position` — pay out an AMM `Position` after settlement.
//!
//! ## Why this exists
//!
//! `trade_positions` credits `Position.yes_shares` / `no_shares` and takes the
//! user's USDC into the AMM vault; this instruction is the ONLY path that pays
//! a settled AMM position back out:
//!
//!   - `claim_refund` is gated on dismissal and on the market not having
//!     settled, so it does not apply to a market that settled normally.
//!     Settlement and dismissal exclude each other, and this instruction also
//!     clears the position's refund accounting — a deposit is paid once, on
//!     exactly one of the two paths.
//!   - `sell_positions` requires `market.is_open()`, so it stops working the
//!     moment the market locks.
//!
//! The payout rule mirrors the book's `redeem_book_seat` exactly — same
//! winning-side logic, same INVALID split, same floor conversion — so the two
//! ledgers pay out identically and neither can drift from the other.
//!
//! ## Why this does NOT close the Position account
//!
//! `claim_unlocked` requires the `Position` PDA to exist (it derives the
//! `LockEntry` seeds from `position.key()` and checks `position.bump`). A user
//! who sold before settlement has outstanding `LockEntry` accounts holding real
//! USDC; closing their `Position` here would strand that USDC.
//!
//! So the shares are zeroed and the account is left in place. That leaks the
//! Position's rent (~0.00083 SOL), which is the strictly safer trade. Reclaiming
//! it needs an outstanding-lock counter — cheap to add later, since `Position`
//! carries 32 reserved bytes.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::AMM_TOKEN_MINT;
use crate::error::SoothCoreError;
use crate::events::Redeemed;
use crate::math::wad_to_base;
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::{AmmState, Market, Position};

#[derive(Accounts)]
pub struct RedeemAmmPosition<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// Decremented as shares are redeemed, so `q_<side> - seed_q_<side>`
    /// always equals the winning shares still unclaimed. `sweep_residual`
    /// gates on that difference reaching zero — without this bookkeeping the
    /// vault's post-settlement surplus is indistinguishable from money still
    /// owed to a slow claimant, and could never be swept.
    #[account(
        mut,
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// CHECK: derived via seeds; signs the vault outflow.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Deliberately NOT `close = user` — see module docs.
    #[account(
        mut,
        seeds = [b"pos", market.market_id.as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = user @ SoothCoreError::Unauthorized,
        has_one = market @ SoothCoreError::Unauthorized,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        address = market.vault_amm @ SoothCoreError::VaultAuthorityMismatch,
        constraint = vault.mint == AMM_TOKEN_MINT
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault.mint, token::authority = user)]
    pub user_amm_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

/// What a settled position is owed, and the mutation that retires it.
pub(crate) struct SettlementClaim {
    pub yes_shares: i128,
    pub no_shares: i128,
    pub usdc_payout: u64,
}

/// Pays a position exactly once, and retires its refund accounting with it.
///
/// Both legs are zeroed **and** `locked_cost_usdc` is cleared: that field is
/// the amount `claim_refund` pays, so leaving it standing would let a position
/// that has taken a settlement payout also be refunded out of the same vault.
/// Clearing it here makes the exclusion a property of the position itself,
/// independent of which lifecycle guard a future instruction remembers to
/// check. A repeat call is a no-op — the account survives settlement, so it IS
/// callable again.
pub(crate) fn consume_position(position: &mut Position, outcome: u8) -> Result<SettlementClaim> {
    // AMM shares are i128 because `trade_positions` and `sell_positions` do
    // signed arithmetic on them, but both assert `>= 0` after every mutation.
    // Re-check rather than trust it: a negative value reaching `wad_to_base`
    // would wrap on the cast.
    let yes_shares = position.yes_shares;
    let no_shares = position.no_shares;
    require!(
        yes_shares >= 0 && no_shares >= 0,
        SoothCoreError::InsufficientShares
    );

    let (yes_wad, no_wad) = (yes_shares as u128, no_shares as u128);
    let payout_wad = match outcome {
        OUTCOME_YES => yes_wad,
        OUTCOME_NO => no_wad,
        OUTCOME_INVALID => {
            yes_wad
                .checked_add(no_wad)
                .ok_or(error!(SoothCoreError::MathOverflow))?
                / 2
        }
        _ => return err!(SoothCoreError::InvalidOutcome),
    };
    let usdc_payout = wad_to_base(payout_wad)?;

    position.yes_shares = 0;
    position.no_shares = 0;
    position.locked_cost_usdc = 0;

    Ok(SettlementClaim {
        yes_shares,
        no_shares,
        usdc_payout,
    })
}

pub fn handler(ctx: Context<RedeemAmmPosition>) -> Result<()> {
    require!(
        ctx.accounts.market.is_settled(),
        SoothCoreError::MarketNotSettled
    );

    // A dismissed market refunds at cost; it never pays a settlement claim.
    // Both flags are checked rather than one: `dismiss_market` writes them
    // together, and this instruction already loads both accounts, so neither
    // has to be trusted alone.
    require!(
        !ctx.accounts.market.is_dismissed && !ctx.accounts.amm_state.is_dismissed,
        SoothCoreError::MarketDismissed
    );

    let outcome = ctx.accounts.market.winning_outcome;
    let claim = consume_position(&mut ctx.accounts.position, outcome)?;
    let (yes_shares_i, no_shares_i) = (claim.yes_shares, claim.no_shares);
    let (yes_shares, no_shares) = (yes_shares_i as u128, no_shares_i as u128);
    let usdc_payout = claim.usdc_payout;

    // Retire the redeemed shares from the outstanding count. `q = seed + Σ
    // positions` is the standing invariant, so an underflow here would mean a
    // position existed that q never counted — fail loud rather than mask it.
    let amm = &mut ctx.accounts.amm_state;
    amm.q_yes = amm
        .q_yes
        .checked_sub(yes_shares_i)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    amm.q_no = amm
        .q_no
        .checked_sub(no_shares_i)
        .ok_or(error!(SoothCoreError::MathOverflow))?;

    if usdc_payout > 0 {
        let market_id = ctx.accounts.market.market_id;
        let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_amm_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            usdc_payout,
        )?;
    }

    emit!(Redeemed {
        user: ctx.accounts.user.key(),
        market: ctx.accounts.market.key(),
        outcome,
        yes_burned: wad_to_base(yes_shares)?,
        no_burned: wad_to_base(no_shares)?,
        usdc_paid: usdc_payout,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::wad::WAD;
    use crate::state::position::position_fixture;

    #[test]
    fn the_winning_side_is_paid_and_the_losing_side_is_not() {
        let mut position = position_fixture();
        position.yes_shares = 3 * WAD;
        position.no_shares = 5 * WAD;
        let claim = consume_position(&mut position, OUTCOME_YES).unwrap();
        assert_eq!(claim.usdc_payout, wad_to_base(3 * WAD as u128).unwrap());
    }

    #[test]
    fn an_invalid_outcome_splits_both_legs() {
        let mut position = position_fixture();
        position.yes_shares = 3 * WAD;
        position.no_shares = 5 * WAD;
        let claim = consume_position(&mut position, OUTCOME_INVALID).unwrap();
        assert_eq!(claim.usdc_payout, wad_to_base(4 * WAD as u128).unwrap());
    }

    #[test]
    fn a_paid_position_carries_no_refund_claim() {
        // The P0 invariant: redeem → dismiss → claim_refund must not pay the
        // deposit a second time. `locked_cost_usdc` is what claim_refund pays.
        let mut position = position_fixture();
        position.yes_shares = 2 * WAD;
        position.locked_cost_usdc = 1_500_000;
        consume_position(&mut position, OUTCOME_YES).unwrap();
        assert_eq!(position.locked_cost_usdc, 0);
    }

    #[test]
    fn a_second_redeem_pays_nothing() {
        let mut position = position_fixture();
        position.yes_shares = 2 * WAD;
        position.locked_cost_usdc = 1_500_000;
        consume_position(&mut position, OUTCOME_YES).unwrap();
        let again = consume_position(&mut position, OUTCOME_YES).unwrap();
        assert_eq!(again.usdc_payout, 0);
        assert_eq!(again.yes_shares, 0);
        assert_eq!(again.no_shares, 0);
    }

    #[test]
    fn a_losing_position_still_gives_up_its_refund_claim() {
        // Payout is zero here, so only the cleared refund accounting stands
        // between this holder and being made whole after a later dismissal.
        let mut position = position_fixture();
        position.no_shares = 4 * WAD;
        position.locked_cost_usdc = 900_000;
        let claim = consume_position(&mut position, OUTCOME_YES).unwrap();
        assert_eq!(claim.usdc_payout, 0);
        assert_eq!(position.locked_cost_usdc, 0);
    }

    #[test]
    fn negative_shares_are_refused_rather_than_wrapped() {
        let mut position = position_fixture();
        position.yes_shares = -1;
        assert!(consume_position(&mut position, OUTCOME_YES).is_err());
        // The position is left untouched, so nothing is silently written off.
        assert_eq!(position.yes_shares, -1);
    }

    #[test]
    fn an_unknown_outcome_is_refused_before_anything_is_zeroed() {
        let mut position = position_fixture();
        position.yes_shares = WAD;
        position.locked_cost_usdc = 42;
        assert!(consume_position(&mut position, 7).is_err());
        assert_eq!(position.yes_shares, WAD);
        assert_eq!(position.locked_cost_usdc, 42);
    }
}
