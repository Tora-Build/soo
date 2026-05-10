//! `redeem_from_program_owned` — burn requested outcome-token amounts from
//! a burn authority and pay USDC to an arbitrary destination token account.
//!
//! This split-destination variant is used by CPI escrow flows where the
//! token holder authority is not the final USDC recipient.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothMarketError;
use crate::events::Redeemed;
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::Market;

#[derive(Accounts)]
pub struct RedeemFromProgramOwned<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: derived via seeds; signs the vault → destination transfer.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.yes_mint @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = market.no_mint @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(address = crate::USDC_MINT_DEVNET)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = market.vault @ SoothMarketError::VaultAuthorityMismatch,
        token::mint = usdc_mint,
        token::authority = vault_authority,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = yes_mint, token::authority = burn_authority)]
    pub source_yes_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = no_mint, token::authority = burn_authority)]
    pub source_no_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = usdc_mint)]
    pub usdc_destination: Box<Account<'info, TokenAccount>>,

    pub burn_authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<RedeemFromProgramOwned>,
    amount_yes: u64,
    amount_no: u64,
) -> Result<()> {
    require!(
        ctx.accounts.market.is_settled(),
        SoothMarketError::MarketNotSettled
    );

    let outcome = ctx.accounts.market.winning_outcome;
    let usdc_payout = match outcome {
        OUTCOME_YES => amount_yes,
        OUTCOME_NO => amount_no,
        OUTCOME_INVALID => {
            amount_yes
                .checked_add(amount_no)
                .ok_or(SoothMarketError::MathOverflow)?
                / 2
        }
        _ => return err!(SoothMarketError::InvalidOutcome),
    };

    if amount_yes == 0 && amount_no == 0 && usdc_payout == 0 {
        return Ok(());
    }

    let market_id = ctx.accounts.market.market_id;
    let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

    // ── 1. Burn requested YES from source_yes_ata ───────────────────────
    if amount_yes > 0 {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.yes_mint.to_account_info(),
                    from: ctx.accounts.source_yes_ata.to_account_info(),
                    authority: ctx.accounts.burn_authority.to_account_info(),
                },
            ),
            amount_yes,
        )?;
    }

    // ── 2. Burn requested NO from source_no_ata ─────────────────────────
    if amount_no > 0 {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.no_mint.to_account_info(),
                    from: ctx.accounts.source_no_ata.to_account_info(),
                    authority: ctx.accounts.burn_authority.to_account_info(),
                },
            ),
            amount_no,
        )?;
    }

    // ── 3. Transfer USDC: vault → destination, signed by vault PDA ──────
    if usdc_payout > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.usdc_destination.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            usdc_payout,
        )?;
    }

    let now = Clock::get()?.unix_timestamp;
    emit!(Redeemed {
        user: ctx.accounts.burn_authority.key(),
        market: ctx.accounts.market.key(),
        outcome,
        yes_burned: amount_yes,
        no_burned: amount_no,
        usdc_paid: usdc_payout,
        ts: now,
    });

    Ok(())
}
