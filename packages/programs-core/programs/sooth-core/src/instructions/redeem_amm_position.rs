//! `redeem_amm_position` — pay out an AMM `Position` after settlement.
//!
//! ## Why this exists (bug B1)
//!
//! It did not. Before this instruction the AMM had **no exit after
//! settlement**, and every winning AMM buyer's funds were permanently
//! stranded on-chain.
//!
//! `trade_positions` credits `Position.yes_shares` / `no_shares` and takes the
//! user's USDC into `market.vault`. Nothing ever paid it back:
//!
//!   - `redeem` reads SPL outcome-token ATA balances, which an AMM buyer never
//!     receives (those come from `mint_complete_set`, a different path).
//!   - `redeem_orderbook` drains `OrderbookPosition`, a separate ledger.
//!   - `redeem_from_program_owned` handles program-owned complete sets.
//!   - `claim_refund` is gated on `amm_state.is_dismissed`, so it does not
//!     apply to a market that settled normally.
//!   - `sell_positions` requires `market.is_open()`, so it stops working the
//!     moment the market locks.
//!
//! The payout rule mirrors `redeem_orderbook` exactly — same winning-side
//! logic, same INVALID split, same floor conversion — so the two ledgers pay
//! out identically and neither can drift from the other.
//!
//! ## Why this does NOT close the Position account
//!
//! `claim_unlocked` requires the `Position` PDA to exist (it derives the
//! `LockEntry` seeds from `position.key()` and checks `position.bump`). A user
//! who sold before settlement has outstanding `LockEntry` accounts holding real
//! USDC; closing their `Position` here would strand that USDC exactly the way
//! this instruction exists to fix.
//!
//! So the shares are zeroed and the account is left in place. That leaks the
//! Position's rent (~0.00083 SOL), which is the strictly safer trade. Reclaiming
//! it needs an outstanding-lock counter — cheap to add later, since `Position`
//! now carries 32 reserved bytes.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::AMM_TOKEN_MINT;
use crate::error::SoothCoreError;
use crate::events::Redeemed;
use crate::math::wad_to_base;
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::{Market, Position};

#[derive(Accounts)]
pub struct RedeemAmmPosition<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

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

pub fn handler(ctx: Context<RedeemAmmPosition>) -> Result<()> {
    require!(
        ctx.accounts.market.is_settled(),
        SoothCoreError::MarketNotSettled
    );

    // AMM shares are i128 because `trade_positions` and `sell_positions` do
    // signed arithmetic on them, but both assert `>= 0` after every mutation.
    // Re-check rather than trust it: a negative value reaching `wad_to_base`
    // would wrap on the cast.
    let yes_shares_i = ctx.accounts.position.yes_shares;
    let no_shares_i = ctx.accounts.position.no_shares;
    require!(
        yes_shares_i >= 0 && no_shares_i >= 0,
        SoothCoreError::InsufficientShares
    );
    let yes_shares = yes_shares_i as u128;
    let no_shares = no_shares_i as u128;

    let outcome = ctx.accounts.market.winning_outcome;
    let payout_wad = match outcome {
        OUTCOME_YES => yes_shares,
        OUTCOME_NO => no_shares,
        OUTCOME_INVALID => yes_shares
            .checked_add(no_shares)
            .ok_or(error!(SoothCoreError::MathOverflow))?
            / 2,
        _ => return err!(SoothCoreError::InvalidOutcome),
    };
    let usdc_payout = wad_to_base(payout_wad)?;

    // Zero both legs before transferring, so a repeat call is a no-op rather
    // than a second payout. (The account survives, so it IS callable again.)
    ctx.accounts.position.yes_shares = 0;
    ctx.accounts.position.no_shares = 0;

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
