//! `redeem_lp` — burn post-graduation LP shares for pro-rata USDC yield.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::constants::AMM_TOKEN_MINT;
use crate::error::SoothCoreError;
use crate::events::LpRedeemed;
use crate::state::{AmmState, Market};

#[derive(Accounts)]
pub struct RedeemLp<'info> {
    // ── Account binding (bug B6) ────────────────────────────────────────
    //
    // `lp_mint` used to be a bare `#[account(mut)] Box<Account<Mint>>` — no
    // seeds, no market, nothing. Payout is
    // `lp_yield_vault.amount * lp_amount / lp_mint.supply`, so anyone could
    // create their own SPL mint with a supply of 1, burn 1 token, and take the
    // ENTIRE global yield vault. `amm_state` was likewise bound only on
    // `is_graduated`, so any graduated market in the protocol satisfied it.
    //
    // Everything is now tied back to one `market`.

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        constraint = amm_state.market == market.key() @ SoothCoreError::AmmStateMarketMismatch,
        constraint = amm_state.is_graduated @ SoothCoreError::NotGraduated,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    #[account(
        mut,
        seeds = [b"lp", market.market_id.as_ref()],
        bump,
    )]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = lp_mint,
        associated_token::authority = user,
    )]
    pub user_lp_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::authority = lp_yield_authority,
        constraint = lp_yield_vault.mint == AMM_TOKEN_MINT
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub lp_yield_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: signer-only PDA derived by seeds.
    #[account(
        seeds = [b"lp_yield_authority"],
        bump,
    )]
    pub lp_yield_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = lp_yield_vault.mint,
        token::authority = user,
    )]
    pub user_amm_ata: Box<Account<'info, TokenAccount>>,

    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RedeemLp>, lp_amount: u64) -> Result<()> {
    require!(
        ctx.accounts.amm_state.is_graduated,
        SoothCoreError::NotGraduated
    );
    require!(lp_amount > 0, SoothCoreError::ZeroLpAmount);

    let lp_supply = ctx.accounts.lp_mint.supply;
    require!(lp_supply > 0, SoothCoreError::EmptyLpSupply);

    let payout_u128 = (ctx.accounts.lp_yield_vault.amount as u128)
        .checked_mul(lp_amount as u128)
        .and_then(|v| v.checked_div(lp_supply as u128))
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    let payout: u64 = payout_u128
        .try_into()
        .map_err(|_| error!(SoothCoreError::MathOverflow))?;

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.lp_mint.to_account_info(),
                from: ctx.accounts.user_lp_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        lp_amount,
    )?;

    if payout > 0 {
        let bump = ctx.bumps.lp_yield_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[b"lp_yield_authority", &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.lp_yield_vault.to_account_info(),
                    to: ctx.accounts.user_amm_ata.to_account_info(),
                    authority: ctx.accounts.lp_yield_authority.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
        )?;
    }

    emit!(LpRedeemed {
        user: ctx.accounts.user.key(),
        lp_burned: lp_amount,
        usdc_paid: payout,
    });

    Ok(())
}
