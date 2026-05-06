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
//! ## Status: STUB
//!
//! The full body is `todo!()` because the redemption flow depends on the
//! adjudicator-CPI integration (architecture §4.4) — specifically the SoothBook
//! escrow-locked positions need to participate in redemption identically to
//! AMM-acquired shares, and the "did the user have a shares-rest-on-book
//! claim" check must be readable from `sooth_book` accounts. We declare the
//! account list and signature now so the SDK can pin its IDL shape early; the
//! transfer/burn CPIs go in once `sooth_adjudicator` lands.
//!
//! Once unstubbed:
//!   - require `market.lifecycle == Settled`
//!   - read `market.winning_outcome`
//!   - compute `payout_usdc` per the EVM rule above (1:1 for winning side,
//!     50:50 split for INVALID)
//!   - burn winning-side outcome tokens from user
//!   - CPI transfer USDC: vault → user, signed by `vault_authority` PDA
//!   - emit redemption event

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

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

    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = market.vault)]
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

pub fn handler(_ctx: Context<Redeem>) -> Result<()> {
    // TODO(architecture §4.4 / §4.5): wire the redemption flow once the
    // adjudicator program lands and the orderbook position-credit
    // representation is fixed. Spec is in the module comment above.
    todo!("redeem — gated on sooth_adjudicator + sooth_book; see architecture §4.5")
}
