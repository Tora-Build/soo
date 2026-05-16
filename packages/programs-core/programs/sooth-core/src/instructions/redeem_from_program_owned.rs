//! `redeem_from_program_owned` — variant of redeem for split-destination flows.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::constants::BASE_TOKEN_MINT;

use crate::error::SoothCoreError;
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

    /// CHECK: derived via seeds.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.yes_mint @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = market.no_mint @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = market.vault @ SoothCoreError::VaultAuthorityMismatch,
        constraint = vault.mint == BASE_TOKEN_MINT
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// USDC destination ATA — may be owned by any authority.
    #[account(mut, token::mint = vault.mint)]
    pub recipient_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// Token account holding YES shares — burned from; authority = `source_authority`.
    #[account(mut, token::mint = yes_mint, token::authority = source_authority)]
    pub source_yes_ata: Box<Account<'info, TokenAccount>>,

    /// Token account holding NO shares — burned from; authority = `source_authority`.
    #[account(mut, token::mint = no_mint, token::authority = source_authority)]
    pub source_no_ata: Box<Account<'info, TokenAccount>>,

    /// Authority over the source token accounts.
    pub source_authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RedeemFromProgramOwned>) -> Result<()> {
    require!(
        ctx.accounts.market.is_settled(),
        SoothCoreError::MarketNotSettled
    );

    let outcome = ctx.accounts.market.winning_outcome;
    let yes_balance = ctx.accounts.source_yes_ata.amount;
    let no_balance = ctx.accounts.source_no_ata.amount;

    let (yes_to_burn, no_to_burn, usdc_payout) = match outcome {
        OUTCOME_YES => (yes_balance, 0u64, yes_balance),
        OUTCOME_NO => (0u64, no_balance, no_balance),
        OUTCOME_INVALID => {
            let total = yes_balance
                .checked_add(no_balance)
                .ok_or(SoothCoreError::MathOverflow)?;
            (yes_balance, no_balance, total / 2)
        }
        _ => return err!(SoothCoreError::InvalidOutcome),
    };

    if yes_to_burn == 0 && no_to_burn == 0 && usdc_payout == 0 {
        return Ok(());
    }

    let market_id = ctx.accounts.market.market_id;
    let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

    if yes_to_burn > 0 {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.yes_mint.to_account_info(),
                    from: ctx.accounts.source_yes_ata.to_account_info(),
                    authority: ctx.accounts.source_authority.to_account_info(),
                },
            ),
            yes_to_burn,
        )?;
    }

    if no_to_burn > 0 {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.no_mint.to_account_info(),
                    from: ctx.accounts.source_no_ata.to_account_info(),
                    authority: ctx.accounts.source_authority.to_account_info(),
                },
            ),
            no_to_burn,
        )?;
    }

    if usdc_payout > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.recipient_usdc_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            usdc_payout,
        )?;
    }

    let now = Clock::get()?.unix_timestamp;
    emit!(Redeemed {
        user: ctx.accounts.source_authority.key(),
        market: ctx.accounts.market.key(),
        outcome,
        yes_burned: yes_to_burn,
        no_burned: no_to_burn,
        usdc_paid: usdc_payout,
        ts: now,
    });

    Ok(())
}
