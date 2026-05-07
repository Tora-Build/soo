//! `redeem` — exchange winning outcome tokens for USDC at the resolved rate.
//!
//! EVM analogue: `OrderEngine.settlePosition` (`OrderEngine.sol:399-431`).
//! Payout rule per `TruthMarket.getRedemptionValue` (`TruthMarket.sol:220-231`):
//!
//! ```solidity
//! if (winningOutcome == 0) return outcome == 0 ? WAD : 0;     // NO wins
//! if (winningOutcome == 1) return outcome == 1 ? WAD : 0;     // YES wins
//! else                      return WAD / 2;                    // INVALID — both half
//! ```
//!
//! ## Behavior
//!
//! Body branches on `market.winning_outcome` (set by `settle`):
//!
//! | winning_outcome | YES burned | NO burned | USDC paid                   |
//! |-----------------|------------|-----------|-----------------------------|
//! | YES (1)         | user_yes   | 0         | user_yes (1.0/share)        |
//! | NO  (0)         | 0          | user_no   | user_no  (1.0/share)        |
//! | INVALID (2)     | user_yes   | user_no   | (user_yes + user_no) / 2    |
//!
//! Outcome-token amounts are SPL base units (6 decimals — same scale as
//! USDC). Mint/merge produces 1:1 base-units-of-shares ↔ base-units-of-USDC,
//! so the payout arithmetic is direct (no WAD-scale conversion).
//!
//! ## Account-list shape decision
//!
//! Both `user_yes_ata` and `user_no_ata` are non-optional in the Accounts
//! struct so the INVALID-outcome branch (which burns both sides) has the
//! handles it needs without relying on `Option<Account>` or remaining-
//! accounts plumbing — neither plays well with Anchor's `#[account]`
//! constraint codegen for token accounts. Callers who only hold one side
//! pass an empty (zero-balance) ATA on the unused side; the burn for that
//! side is skipped (`amount == 0`). Same shape as `merge_complete_set`,
//! which also wants both ATAs in scope.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothMarketError;
use crate::events::Redeemed;
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::Market;

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: derived via seeds; signs the vault → user transfer.
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

    /// Market USDC vault. The canonical-USDC pin is transitive via
    /// `initialize_market_vaults` (same chain documented on
    /// `mint_complete_set`/`merge_complete_set`); the explicit
    /// `vault.mint == USDC_MINT_DEVNET` constraint here is cheap defense-
    /// in-depth and keeps the IDL self-documenting.
    #[account(
        mut,
        address = market.vault @ SoothMarketError::VaultAuthorityMismatch,
        constraint = vault.mint == crate::USDC_MINT_DEVNET
            @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault.mint, token::authority = user)]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = yes_mint, token::authority = user)]
    pub user_yes_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = no_mint, token::authority = user)]
    pub user_no_ata: Box<Account<'info, TokenAccount>>,

    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Redeem>) -> Result<()> {
    require!(
        ctx.accounts.market.is_settled(),
        SoothMarketError::MarketNotSettled
    );

    let outcome = ctx.accounts.market.winning_outcome;
    let yes_balance = ctx.accounts.user_yes_ata.amount;
    let no_balance = ctx.accounts.user_no_ata.amount;

    // Compute (yes_to_burn, no_to_burn, usdc_payout) per the EVM redemption
    // table. Arithmetic is on u64 base units; `usdc_payout` is bounded by
    // the user's balance which is itself bounded by total minted complete
    // sets (= total USDC in the vault), so the sum cannot overflow u64.
    let (yes_to_burn, no_to_burn, usdc_payout) = match outcome {
        OUTCOME_YES => (yes_balance, 0u64, yes_balance),
        OUTCOME_NO => (0u64, no_balance, no_balance),
        OUTCOME_INVALID => {
            // Half-payout per side, summed. Use checked add so a malformed
            // ATA balance can't trip silent overflow on the sum.
            let total = yes_balance
                .checked_add(no_balance)
                .ok_or(SoothMarketError::MathOverflow)?;
            (yes_balance, no_balance, total / 2)
        }
        _ => return err!(SoothMarketError::InvalidOutcome),
    };

    // Nothing to redeem — the user holds no winning shares (or no shares at
    // all on INVALID). Treat as a no-op rather than an error so callers can
    // fan-out a redeem-all loop without per-market guards. Mirrors EVM's
    // `payout > 0` check around the safeTransfer.
    if yes_to_burn == 0 && no_to_burn == 0 && usdc_payout == 0 {
        return Ok(());
    }

    let market_id = ctx.accounts.market.market_id;
    let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

    // ── 1. Burn YES (if applicable) ─────────────────────────────────────
    if yes_to_burn > 0 {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.yes_mint.to_account_info(),
                    from: ctx.accounts.user_yes_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            yes_to_burn,
        )?;
    }

    // ── 2. Burn NO (if applicable) ──────────────────────────────────────
    if no_to_burn > 0 {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.no_mint.to_account_info(),
                    from: ctx.accounts.user_no_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            no_to_burn,
        )?;
    }

    // ── 3. Transfer USDC: vault → user, signed by vault_authority PDA ───
    if usdc_payout > 0 {
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

    let now = Clock::get()?.unix_timestamp;
    emit!(Redeemed {
        user: ctx.accounts.user.key(),
        market: ctx.accounts.market.key(),
        outcome,
        yes_burned: yes_to_burn,
        no_burned: no_to_burn,
        usdc_paid: usdc_payout,
        ts: now,
    });

    Ok(())
}
