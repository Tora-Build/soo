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

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::error::SoothCoreError;
use crate::events::ResidualSwept;
use crate::math::wad_to_base;
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
    #[account(
        seeds = [b"lp_position", market.market_id.as_ref(), market.creator.as_ref()],
        bump = lp_position.bump,
    )]
    pub lp_position: Box<Account<'info, LpPosition>>,

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
        OUTCOME_INVALID => {
            amm.q_yes == amm.seed_q_yes && amm.q_no == amm.seed_q_no
        }
        _ => return err!(SoothCoreError::InvalidOutcome),
    };
    require!(drained, SoothCoreError::OutstandingClaims);

    // Reserve the creator's unreclaimed subsidy. `reclaim_subsidy` is capped
    // at `posted - reclaimed`, so exactly that much of the balance is still
    // the creator's to take; only what lies above it is residual.
    let posted = wad_to_base(ctx.accounts.lp_position.seed_deposit_wad)?;
    let reserved = posted.saturating_sub(ctx.accounts.lp_position.reclaimed_base);
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
