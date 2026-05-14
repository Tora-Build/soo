//! `redeem_orderbook` — redeem shares from OrderbookPosition after settlement.
//!
//! Adapted from `sooth_market::redeem_orderbook`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::BASE_TOKEN_MINT;

use crate::error::SoothCoreError;
use crate::events::Redeemed;
use crate::instructions::orderbook_common::{ensure_position_identity, wad_to_base};
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::{Market, OrderbookPosition};

#[derive(Accounts)]
pub struct RedeemOrderbook<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: derived via seeds.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        close = user,
        seeds = [b"orderbook_position", market.market_id.as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, OrderbookPosition>>,

    #[account(
        mut,
        address = market.vault @ SoothCoreError::VaultAuthorityMismatch,
        constraint = vault.mint == BASE_TOKEN_MINT
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault.mint, token::authority = user)]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RedeemOrderbook>) -> Result<()> {
    require!(
        ctx.accounts.market.is_settled(),
        SoothCoreError::MarketNotSettled
    );

    ensure_position_identity(
        &mut ctx.accounts.position,
        ctx.accounts.market.key(),
        ctx.accounts.user.key(),
    )?;

    let outcome = ctx.accounts.market.winning_outcome;
    let yes_shares = ctx.accounts.position.yes_shares;
    let no_shares = ctx.accounts.position.no_shares;
    let payout_wad = match outcome {
        OUTCOME_YES => yes_shares,
        OUTCOME_NO => no_shares,
        OUTCOME_INVALID => {
            yes_shares
                .checked_add(no_shares)
                .ok_or(error!(SoothCoreError::MathOverflow))?
                / 2
        }
        _ => return err!(SoothCoreError::InvalidOutcome),
    };
    let usdc_payout = wad_to_base(payout_wad)?;

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
                    to: ctx.accounts.user_usdc_ata.to_account_info(),
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
