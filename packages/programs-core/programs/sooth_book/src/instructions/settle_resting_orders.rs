use anchor_lang::prelude::*;
use anchor_lang::solana_program::{sysvar, sysvar::instructions as ix_sysvar};
use anchor_lang::AccountDeserialize;
use anchor_spl::token::{Mint, Token, TokenAccount};
use sooth_market::program::SoothMarket;

use crate::error::CoreError;
use crate::state::market_account::Market;
use crate::state::order_account::{Order, OrderStatus};

const OUTCOME_NO: u16 = 0;
const OUTCOME_YES: u16 = 1;
const OUTCOME_INVALID: u8 = 2;

#[event]
pub struct RestingOrderSettled {
    pub order: Pubkey,
    pub purchaser: Pubkey,
    pub outcome: u16,
    pub winning_outcome: u8,
    pub payout: u64,
}

#[derive(Accounts)]
pub struct SettleRestingOrders<'info> {
    /// CHECK: matched to `sooth_market.adjudicator`; parent ix auth is checked in handler.
    pub adjudicator: UncheckedAccount<'info>,

    #[account(
        mut,
        owner = sooth_market::ID @ CoreError::MarketMismatch,
    )]
    /// CHECK: owner-pinned and deserialized in the handler to avoid IDL
    /// account-name collisions with SoothBook's own `Market`.
    pub sooth_market_pda: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"market", sooth_market_pda.key().as_ref()],
        bump,
        constraint = book_market.sooth_market_pda == sooth_market_pda.key() @ CoreError::MarketMismatch,
    )]
    pub book_market: Box<Account<'info, Market>>,

    #[account(
        mut,
        close = order_purchaser,
        constraint = order.market == book_market.key() @ CoreError::SettlementMarketMismatch,
        constraint = order.purchaser == order_purchaser.key() @ CoreError::SettlementPayerMismatch,
    )]
    pub order: Box<Account<'info, Order>>,
    #[account(mut)]
    pub order_purchaser: SystemAccount<'info>,

    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(address = sooth_market::USDC_MINT_DEVNET)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = sooth_market_vault_authority,
    )]
    pub sooth_market_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: signer-only PDA owned by `sooth_market`; derivation checked in handler.
    pub sooth_market_vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = market_escrow_authority,
    )]
    pub market_escrow_yes: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = no_mint,
        token::authority = market_escrow_authority,
    )]
    pub market_escrow_no: Box<Account<'info, TokenAccount>>,
    #[account(
        seeds = [b"escrow", book_market.key().as_ref()],
        bump = book_market.escrow_account_bump,
    )]
    /// CHECK: PDA authority for the YES/NO escrow token accounts.
    pub market_escrow_authority: UncheckedAccount<'info>,

    #[account(mut, token::mint = usdc_mint, token::authority = order_purchaser)]
    pub purchaser_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(address = sysvar::instructions::ID)]
    /// CHECK: address-pinned sysvar, read by the parent-ix auth gate.
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub sooth_market_program: Program<'info, SoothMarket>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SettleRestingOrders>) -> Result<()> {
    let sooth_market = load_sooth_market(&ctx.accounts.sooth_market_pda)?;
    require!(
        sooth_market.is_settled(),
        CoreError::SettlementMarketNotSettled
    );
    require_keys_eq!(
        ctx.accounts.adjudicator.key(),
        sooth_market.adjudicator,
        CoreError::Unauthorized
    );
    require_keys_eq!(
        ctx.accounts.yes_mint.key(),
        sooth_market.yes_mint,
        CoreError::MarketMismatch
    );
    require_keys_eq!(
        ctx.accounts.no_mint.key(),
        sooth_market.no_mint,
        CoreError::MarketMismatch
    );
    require_keys_eq!(
        ctx.accounts.sooth_market_vault.key(),
        sooth_market.vault,
        CoreError::MarketMismatch
    );
    require_parent_program(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &sooth_market.adjudicator,
    )?;

    let (expected_vault_authority, _) = Pubkey::find_program_address(
        &[b"vault", sooth_market.market_id.as_ref()],
        &sooth_market::ID,
    );
    require_keys_eq!(
        ctx.accounts.sooth_market_vault_authority.key(),
        expected_vault_authority,
        CoreError::MarketMismatch
    );

    let outcome = ctx.accounts.order.market_outcome_index;
    require!(
        outcome == OUTCOME_NO || outcome == OUTCOME_YES,
        CoreError::InvalidOutcome
    );

    let winning_outcome = sooth_market.winning_outcome;
    let stake_unmatched = ctx.accounts.order.stake_unmatched;
    let payout = calculate_payout(stake_unmatched, outcome, winning_outcome)?;
    let (amount_yes, amount_no) = redeem_amounts(stake_unmatched, outcome)?;

    if amount_yes > 0 || amount_no > 0 {
        let book_market_key = ctx.accounts.book_market.key();
        let escrow_bump = ctx.accounts.book_market.escrow_account_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"escrow", book_market_key.as_ref(), &[escrow_bump]]];

        sooth_market::cpi::redeem_from_program_owned(
            CpiContext::new_with_signer(
                ctx.accounts.sooth_market_program.to_account_info(),
                sooth_market::cpi::accounts::RedeemFromProgramOwned {
                    market: ctx.accounts.sooth_market_pda.to_account_info(),
                    vault_authority: ctx.accounts.sooth_market_vault_authority.to_account_info(),
                    yes_mint: ctx.accounts.yes_mint.to_account_info(),
                    no_mint: ctx.accounts.no_mint.to_account_info(),
                    usdc_mint: ctx.accounts.usdc_mint.to_account_info(),
                    market_vault: ctx.accounts.sooth_market_vault.to_account_info(),
                    source_yes_ata: ctx.accounts.market_escrow_yes.to_account_info(),
                    source_no_ata: ctx.accounts.market_escrow_no.to_account_info(),
                    usdc_destination: ctx.accounts.purchaser_usdc_ata.to_account_info(),
                    burn_authority: ctx.accounts.market_escrow_authority.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
                signer_seeds,
            ),
            amount_yes,
            amount_no,
        )?;
    }

    ctx.accounts.order.payout = payout;
    ctx.accounts.order.stake_unmatched = 0;
    ctx.accounts.order.order_status = if payout > 0 {
        OrderStatus::SettledWin
    } else {
        OrderStatus::SettledLose
    };
    ctx.accounts.book_market.decrement_account_counts()?;

    emit!(RestingOrderSettled {
        order: ctx.accounts.order.key(),
        purchaser: ctx.accounts.order.purchaser,
        outcome,
        winning_outcome,
        payout,
    });

    Ok(())
}

fn load_sooth_market(market_pda: &UncheckedAccount) -> Result<sooth_market::state::Market> {
    let mut data = &market_pda.try_borrow_data()?[..];
    sooth_market::state::Market::try_deserialize(&mut data)
        .map_err(|_| error!(CoreError::MarketMismatch))
}

fn require_parent_program(
    instruction_sysvar: &AccountInfo,
    expected_program: &Pubkey,
) -> Result<()> {
    let current_index = ix_sysvar::load_current_index_checked(instruction_sysvar)? as usize;

    for i in 0..=current_index {
        let ix = ix_sysvar::load_instruction_at_checked(i, instruction_sysvar)?;
        if ix.program_id == *expected_program {
            return Ok(());
        }
    }

    err!(CoreError::Unauthorized)
}

fn calculate_payout(stake_unmatched: u64, outcome: u16, winning_outcome: u8) -> Result<u64> {
    match (winning_outcome, outcome) {
        (sooth_market::state::market::OUTCOME_YES, OUTCOME_YES) => Ok(stake_unmatched),
        (sooth_market::state::market::OUTCOME_NO, OUTCOME_NO) => Ok(stake_unmatched),
        (OUTCOME_INVALID, _) => Ok(stake_unmatched / 2),
        (sooth_market::state::market::OUTCOME_YES, OUTCOME_NO)
        | (sooth_market::state::market::OUTCOME_NO, OUTCOME_YES) => Ok(0),
        _ => err!(CoreError::InvalidOutcome),
    }
}

fn redeem_amounts(stake_unmatched: u64, outcome: u16) -> Result<(u64, u64)> {
    match outcome {
        OUTCOME_YES => Ok((stake_unmatched, 0)),
        OUTCOME_NO => Ok((0, stake_unmatched)),
        _ => err!(CoreError::InvalidOutcome),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payout_for_winning_yes_order_is_full_stake() {
        assert_eq!(
            calculate_payout(100, OUTCOME_YES, sooth_market::state::market::OUTCOME_YES).unwrap(),
            100
        );
    }

    #[test]
    fn payout_for_invalid_market_is_half_stake() {
        assert_eq!(
            calculate_payout(101, OUTCOME_NO, OUTCOME_INVALID).unwrap(),
            50
        );
    }

    #[test]
    fn payout_for_losing_order_is_zero() {
        assert_eq!(
            calculate_payout(100, OUTCOME_YES, sooth_market::state::market::OUTCOME_NO).unwrap(),
            0
        );
    }
}
