//! `merge_complete_set` — burn `amount` YES + `amount` NO, return `amount`
//! USDC to the user.
//!
//! EVM analogue: `OrderEngine._merge` (`OrderEngine.sol:696-712`):
//!
//! ```solidity
//! pos.yesShares -= amount;
//! pos.noShares  -= amount;
//! _collateralBacking[market] -= collateralOut;
//! baseToken.safeTransfer(user, collateralOut);
//! ```
//!
//! ## Atomic-escrow connection (decision-log D5)
//!
//! `merge_complete_set` is the function the orderbook escrow buyback path
//! must call atomically when an escrow taker fills against an escrow maker —
//! both sides hold opposite-side shares as collateral, the cross releases
//! both legs back to USDC, and the trade clears net. See `docs/decision-log.md`
//! D5 for the EVM source-of-truth (the telegram app's only sell route relies
//! on atomic escrow). The Solana orderbook (`sooth_book`) will CPI into this
//! instruction in the same TX as the order match — keep this handler's
//! account list small and CPI-friendly.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothMarketError;
use crate::events::CompleteSetMerged;
use crate::state::Market;

#[derive(Accounts)]
pub struct MergeCompleteSet<'info> {
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
        address = market.yes_mint @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = market.no_mint @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = market.vault @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// User's USDC ATA — credited.
    #[account(mut, token::mint = vault.mint, token::authority = user)]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's YES outcome-token ATA — burned from.
    #[account(mut, token::mint = yes_mint, token::authority = user)]
    pub user_yes_ata: Box<Account<'info, TokenAccount>>,

    /// User's NO outcome-token ATA — burned from.
    #[account(mut, token::mint = no_mint, token::authority = user)]
    pub user_no_ata: Box<Account<'info, TokenAccount>>,

    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<MergeCompleteSet>, amount: u64) -> Result<()> {
    require!(amount > 0, SoothMarketError::ZeroAmount);
    // Merging is permitted while the market is Open (and arguably while
    // Locked — EVM's `_merge` has no `requireBeforeDeadline` guard, since
    // unwinding a complete set is always safe). For v1 we mirror the EVM
    // permissiveness: allow any non-Settled state.
    require!(
        !ctx.accounts.market.is_settled(),
        SoothMarketError::MarketNotOpen
    );
    require!(
        ctx.accounts.user_yes_ata.amount >= amount && ctx.accounts.user_no_ata.amount >= amount,
        SoothMarketError::InsufficientOutcomeShares
    );

    let market_id = ctx.accounts.market.market_id;
    let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

    // ── 1. Burn YES from user_yes_ata ────────────────────────────────────
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.yes_mint.to_account_info(),
                from: ctx.accounts.user_yes_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // ── 2. Burn NO from user_no_ata ──────────────────────────────────────
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.no_mint.to_account_info(),
                from: ctx.accounts.user_no_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // ── 3. Transfer USDC: vault → user, signed by vault_authority PDA ────
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
        amount,
    )?;

    let now = Clock::get()?.unix_timestamp;
    emit!(CompleteSetMerged {
        market: ctx.accounts.market.key(),
        user: ctx.accounts.user.key(),
        amount_usdc: amount,
        ts: now,
    });

    Ok(())
}
