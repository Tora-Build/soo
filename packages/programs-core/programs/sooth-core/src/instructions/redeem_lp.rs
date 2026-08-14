//! `redeem_lp` — burn post-graduation LP shares for pro-rata yield from
//! BOTH venues, in one instruction.
//!
//! ## Why one burn pays two vaults
//!
//! LP yield accrues in two currencies: the AMM's fees in its own token, the
//! book's in USDC. The LP token is the claim on both — so a redemption that
//! paid only one venue and burned the LP would silently forfeit the holder's
//! share of the other. Splitting this into two instructions would need
//! per-holder claimed-per-venue bookkeeping to prevent exactly that; one
//! atomic burn needs none.
//!
//! ## Why the vaults are per-market
//!
//! They were global (one ATA of the singleton `lp_yield_authority` per mint),
//! and payout divided the GLOBAL pool by THIS market's LP supply — so a dust
//! market's sole LP could take every market's yield. The vaults are now
//! seeded by `market_id`; each market's yield is claimable only against its
//! own supply.

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

    /// THIS market's AMM-side yield vault.
    #[account(
        mut,
        seeds = [b"lp_yield_amm", market.market_id.as_ref()],
        bump,
        token::authority = lp_yield_authority,
        constraint = lp_yield_amm.mint == AMM_TOKEN_MINT
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub lp_yield_amm: Box<Account<'info, TokenAccount>>,

    /// THIS market's book-side yield vault, in the book's token.
    #[account(
        mut,
        seeds = [b"lp_yield_book", market.market_id.as_ref()],
        bump,
        token::authority = lp_yield_authority,
        constraint = lp_yield_book.mint == crate::constants::BOOK_TOKEN_MINT
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub lp_yield_book: Box<Account<'info, TokenAccount>>,

    /// CHECK: signer-only PDA derived by seeds.
    #[account(
        seeds = [b"lp_yield_authority"],
        bump,
    )]
    pub lp_yield_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = lp_yield_amm.mint,
        token::authority = user,
    )]
    pub user_amm_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = lp_yield_book.mint,
        token::authority = user,
    )]
    pub user_book_ata: Box<Account<'info, TokenAccount>>,

    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RedeemLp>, lp_amount: u64) -> Result<()> {
    // The incubation lock ends when the market's story does — by graduating,
    // by settling, or by being dismissed. Gating on graduation ALONE meant a
    // market that settled without graduating (most incubation failures) had
    // its LP yield distributed into a vault `redeem_lp` refused to open:
    // stranded by construction, and blocking `close_market` forever, since
    // unclaimed LP yield is a claim the close rightly refuses to destroy.
    require!(
        ctx.accounts.amm_state.is_graduated
            || ctx.accounts.market.is_settled()
            || ctx.accounts.amm_state.is_dismissed,
        SoothCoreError::NotGraduated
    );
    require!(lp_amount > 0, SoothCoreError::ZeroLpAmount);

    let lp_supply = ctx.accounts.lp_mint.supply;
    require!(lp_supply > 0, SoothCoreError::EmptyLpSupply);

    // Both shares from the PRE-burn supply, so the two venues use the same
    // denominator and a holder's fraction is identical on each.
    let share = |vault: u64| -> Result<u64> {
        (vault as u128)
            .checked_mul(lp_amount as u128)
            .and_then(|v| v.checked_div(lp_supply as u128))
            .ok_or(error!(SoothCoreError::MathOverflow))?
            .try_into()
            .map_err(|_| error!(SoothCoreError::MathOverflow))
    };
    let payout = share(ctx.accounts.lp_yield_amm.amount)?;
    let payout_book = share(ctx.accounts.lp_yield_book.amount)?;

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

    let bump = ctx.bumps.lp_yield_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[b"lp_yield_authority", &[bump]]];
    for (vault, dest, amount) in [
        (
            ctx.accounts.lp_yield_amm.to_account_info(),
            ctx.accounts.user_amm_ata.to_account_info(),
            payout,
        ),
        (
            ctx.accounts.lp_yield_book.to_account_info(),
            ctx.accounts.user_book_ata.to_account_info(),
            payout_book,
        ),
    ] {
        if amount == 0 {
            continue;
        }
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: vault,
                    to: dest,
                    authority: ctx.accounts.lp_yield_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    }

    emit!(LpRedeemed {
        user: ctx.accounts.user.key(),
        lp_burned: lp_amount,
        usdc_paid: payout,
        book_paid: payout_book,
    });

    Ok(())
}
