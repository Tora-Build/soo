//! `sweep_residual` — move a settled market's unowed AMM surplus to the
//! treasury, so the vault can reach zero and the market can be closed.
//!
//! ## Why a surplus exists at all
//!
//! The LMSR collects more than it pays out: the cost function's curvature is
//! the traders' aggregate loss, and fees' `b_base` slice is returned to the
//! vault by `distribute_fees`. After every winner has redeemed and the
//! creator has reclaimed their subsidy, the vault still holds that surplus,
//! and no other instruction can touch it: `reclaim_subsidy` is capped at what
//! the creator posted, redemptions are capped at shares held. Without this
//! sweep the money would be stranded, and `close_market` blocked with it.
//!
//! ## Why sweeping is safe — the outstanding-claims gate
//!
//! The danger is sweeping money that still backs a claim: an unredeemed
//! winner's payout looks exactly like surplus to a naive balance check. The
//! gate is exact, not heuristic:
//!
//!   `AmmState.q_<winner>` counts winning shares outstanding, and
//!   `seed_q_<winner>` is the virtual floor seeded at creation that no
//!   Position ever backs. `redeem_amm_position` decrements `q` as it
//!   pays, so `q_winner == seed_q_winner` holds exactly when every real
//!   winning share has been redeemed — and only then is the remaining
//!   balance provably owed to nobody.
//!
//! An INVALID outcome pays both legs, so both sides must be drained to their
//! floors.
//!
//! ## Where it goes, and who may call
//!
//! To the protocol treasury, pinned the same way `distribute_fees` pins it:
//! `token::authority = config.treasury`, so a permissionless cranker chooses
//! nothing. Not to the creator — the surplus is trader losses, and letting
//! the market's own creator harvest them buys the wrong incentive for the
//! price of a convenience.
//!
//! Book-venue residuals need no sweep: the book is zero-sum between seats
//! (fees leave via the fee pool), so `vault_book` reaches zero organically
//! once every seat withdraws.
//!
//! The LP yield vaults strand for a different reason and are recovered by
//! `sweep_lp_yield`, in its own module: it names both venues' mints, and the
//! venue-separation invariant is asserted per source file.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothCoreError;
use crate::events::ResidualSwept;
use crate::math::wad_to_base;
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::{AmmState, LpPosition, Market, ProtocolConfig};

#[derive(Accounts)]
pub struct SweepResidual<'info> {
    #[account(seeds = [b"protocol_config"], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// CHECK: signer-only PDA; authority on the AMM vault.
    #[account(seeds = [b"vault", market.market_id.as_ref()], bump = market.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(address = crate::constants::AMM_TOKEN_MINT)]
    pub venue_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = market.vault_amm @ SoothCoreError::VaultAuthorityMismatch,
        token::mint = venue_mint,
    )]
    pub vault_amm: Box<Account<'info, TokenAccount>>,

    /// The creator's subsidy ledger. Read-only here: the sweep must LEAVE the
    /// unreclaimed portion of the subsidy in the vault, because a
    /// permissionless instruction that takes the full balance can be fired
    /// before the creator runs `reclaim_subsidy` — confiscating their posted
    /// capital to the treasury. The gate above protects winners; this
    /// reservation protects the creator. Both are claimants; neither may be
    /// raced.
    ///
    /// Unchecked rather than `Account<LpPosition>` so that a market which was
    /// never seeded can still be swept. `seed_lp` is a SEPARATE instruction
    /// from `create_market`, so a market can be created, traded and settled
    /// with no `LpPosition` ever existing — and an `Account<…>` here would
    /// fail to deserialize, leaving that market's surplus unsweepable and
    /// `close_market` (which requires an empty vault) blocked forever.
    ///
    /// Absence is PROVEN, not assumed: the seeds pin the address, and only
    /// the real PDA can be system-owned and empty. So a cranker cannot skip
    /// the creator's reserve by omitting the account — there is nothing to
    /// omit, and substituting a different account fails the seeds.
    ///
    /// CHECK: address fixed by seeds; ownership and length checked in the
    /// handler before it is deserialized.
    #[account(
        seeds = [b"lp_position", market.market_id.as_ref(), market.creator.as_ref()],
        bump,
    )]
    pub lp_position: UncheckedAccount<'info>,

    /// The treasury's account for the AMM's token — owner pinned by config,
    /// exactly as in `distribute_fees`. The cranker chooses nothing.
    #[account(
        mut,
        token::authority = config.treasury,
        token::mint = venue_mint,
    )]
    pub protocol_treasury_vault: Box<Account<'info, TokenAccount>>,

    /// Permissionless, like fee distribution: the residual must not be
    /// hostage to any one keeper, and every destination above is fixed.
    pub cranker: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

/// The creator's subsidy ledger, or `None` when `seed_lp` never ran.
///
/// A PDA that has not been created is owned by the system program and holds
/// no data — that combination is only reachable for an account that does not
/// exist, so it is proof of absence rather than a caller's assertion.
fn read_lp_position(account: &UncheckedAccount) -> Result<Option<LpPosition>> {
    let info = account.to_account_info();
    if info.owner != &crate::ID || info.data_is_empty() {
        return Ok(None);
    }
    let data = info.try_borrow_data()?;
    Ok(Some(LpPosition::try_deserialize(&mut &data[..])?))
}

/// What the sweep must leave behind for the creator: everything
/// `reclaim_subsidy` could still pay them, and nothing more.
fn reserved_subsidy(lp: Option<&LpPosition>) -> Result<u64> {
    let Some(lp) = lp else { return Ok(0) };
    let posted = wad_to_base(lp.seed_deposit_wad)?;
    Ok(posted.saturating_sub(lp.reclaimed_base))
}

pub fn handler(ctx: Context<SweepResidual>) -> Result<()> {
    require!(
        ctx.accounts.market.is_settled(),
        SoothCoreError::MarketNotSettled
    );

    // The exact gate: every real winning share redeemed, down to the virtual
    // seed floor. See module docs.
    let amm = &ctx.accounts.amm_state;
    let drained = match ctx.accounts.market.winning_outcome {
        OUTCOME_YES => amm.q_yes == amm.seed_q_yes,
        OUTCOME_NO => amm.q_no == amm.seed_q_no,
        OUTCOME_INVALID => amm.q_yes == amm.seed_q_yes && amm.q_no == amm.seed_q_no,
        _ => return err!(SoothCoreError::InvalidOutcome),
    };
    require!(drained, SoothCoreError::OutstandingClaims);

    // Reserve the creator's unreclaimed subsidy. `reclaim_subsidy` is capped
    // at `posted - reclaimed`, so exactly that much of the balance is still
    // the creator's to take; only what lies above it is residual.
    //
    // No ledger means nothing was ever posted, so nothing is reserved — see
    // the account's docs for why absence is provable here.
    let reserved = reserved_subsidy(read_lp_position(&ctx.accounts.lp_position)?.as_ref())?;
    let amount = ctx.accounts.vault_amm.amount.saturating_sub(reserved);
    require!(amount > 0, SoothCoreError::NothingToDistribute);

    let market_id = ctx.accounts.market.market_id;
    let bump = ctx.accounts.market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[bump]]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_amm.to_account_info(),
                to: ctx.accounts.protocol_treasury_vault.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    emit!(ResidualSwept {
        market: ctx.accounts.market.key(),
        market_id,
        amount,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::wad::WAD;

    fn lp(seed_deposit_wad: u128, reclaimed_base: u64) -> LpPosition {
        LpPosition {
            market: Pubkey::new_unique(),
            creator: Pubkey::new_unique(),
            lp_mint: Pubkey::new_unique(),
            seed_deposit_wad,
            graduated_at: 0,
            bump: 255,
            reclaimed_base,
            _reserved: [0u8; 24],
        }
    }

    #[test]
    fn an_unseeded_market_reserves_nothing() {
        // `seed_lp` is a separate instruction from `create_market`, so a
        // market can settle having never posted a subsidy. Before this, the
        // missing ledger failed the whole instruction and the surplus — and
        // `close_market` behind it — was stranded for good.
        assert_eq!(reserved_subsidy(None).unwrap(), 0);
    }

    #[test]
    fn the_unreclaimed_subsidy_is_reserved_in_full() {
        // The creator's protection: a permissionless sweep fired before they
        // call `reclaim_subsidy` must not take capital they posted.
        let position = lp(100 * WAD as u128, 0);
        assert_eq!(reserved_subsidy(Some(&position)).unwrap(), 100_000_000);
    }

    #[test]
    fn only_what_is_still_reclaimable_is_reserved() {
        let position = lp(100 * WAD as u128, 40_000_000);
        assert_eq!(reserved_subsidy(Some(&position)).unwrap(), 60_000_000);
    }

    #[test]
    fn a_fully_reclaimed_subsidy_reserves_nothing() {
        // Saturating, not wrapping: over-reclaim would otherwise reserve a
        // near-u64::MAX and make the residual permanently unsweepable.
        let position = lp(100 * WAD as u128, 250_000_000);
        assert_eq!(reserved_subsidy(Some(&position)).unwrap(), 0);
    }
}
