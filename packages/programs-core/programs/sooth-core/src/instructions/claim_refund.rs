//! `claim_refund` — refund a dismissed-market AMM Position.
//!
//! Adapted from `sooth_market::claim_refund`. The CPI to
//! `sooth_amm::close_dismissed_position` is replaced with a direct call to
//! `close_dismissed_position_internal`. `sooth_amm_program` and
//! `instruction_sysvar` are removed from the account list.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::{
    POSITION_LOCKED_COST_USDC_OFFSET, POSITION_MARKET_OFFSET,
    POSITION_TOTAL_LEN as POSITION_MIN_LEN, POSITION_USER_OFFSET,
};
use crate::constants::BASE_TOKEN_MINT;

use crate::error::SoothCoreError;
use crate::events::RefundClaimed;
use crate::state::{AmmState, Market};

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// AMM state for this market. Must be dismissed.
    #[account(
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        constraint = amm_state.market == market.key() @ SoothCoreError::AmmStateMarketMismatch,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// Vault authority signer-only PDA.
    /// CHECK: derived via seeds.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault @ SoothCoreError::VaultAuthorityMismatch,
        constraint = market_vault.mint == BASE_TOKEN_MINT
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = user,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// AMM Position account — closed by the inline `close_dismissed_position`.
    /// CHECK: validated in handler body.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    #[account(address = BASE_TOKEN_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimRefund>) -> Result<()> {
    let market_id = ctx.accounts.market.market_id;
    let market_key = ctx.accounts.market.key();
    let user_key = ctx.accounts.user.key();

    // Validate AmmState is dismissed.
    require!(
        ctx.accounts.amm_state.is_dismissed,
        SoothCoreError::MarketNotDismissed
    );

    let locked_cost_usdc =
        read_and_validate_position(&ctx.accounts.position, &market_id, &market_key, &user_key)?;

    if locked_cost_usdc > 0 {
        let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.user_usdc_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            locked_cost_usdc,
        )?;
    }

    // Close the position account (rent → user).
    close_position_account(&ctx.accounts.position, &ctx.accounts.user)?;

    emit!(RefundClaimed {
        market: market_key,
        user: user_key,
        amount_usdc: locked_cost_usdc,
    });

    Ok(())
}

fn read_and_validate_position(
    position: &UncheckedAccount,
    market_id: &[u8; 16],
    market_key: &Pubkey,
    user_key: &Pubkey,
) -> Result<u64> {
    let (expected_position, _) = Pubkey::find_program_address(
        &[b"pos", market_id.as_ref(), user_key.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(
        position.key(),
        expected_position,
        SoothCoreError::VaultAuthorityMismatch
    );
    require_keys_eq!(
        *position.to_account_info().owner,
        crate::ID,
        SoothCoreError::VaultAuthorityMismatch
    );

    let data = position.try_borrow_data()?;
    require!(
        data.len() >= POSITION_MIN_LEN,
        SoothCoreError::VaultAuthorityMismatch
    );
    let pos_user = Pubkey::new_from_array(
        data[POSITION_USER_OFFSET..POSITION_USER_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(SoothCoreError::VaultAuthorityMismatch))?,
    );
    let pos_market = Pubkey::new_from_array(
        data[POSITION_MARKET_OFFSET..POSITION_MARKET_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(SoothCoreError::VaultAuthorityMismatch))?,
    );
    let locked_cost_usdc = u64::from_le_bytes(
        data[POSITION_LOCKED_COST_USDC_OFFSET..POSITION_LOCKED_COST_USDC_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(SoothCoreError::VaultAuthorityMismatch))?,
    );
    drop(data);

    require_keys_eq!(
        pos_user,
        *user_key,
        SoothCoreError::VaultAuthorityMismatch
    );
    require_keys_eq!(
        pos_market,
        *market_key,
        SoothCoreError::VaultAuthorityMismatch
    );
    Ok(locked_cost_usdc)
}

/// Close a position account by zeroing its data and moving its lamports to
/// the user. This replaces the CPI to `sooth_amm::close_dismissed_position`.
fn close_position_account(position: &UncheckedAccount, user: &Signer) -> Result<()> {
    let dest = user.to_account_info();
    let src = position.to_account_info();

    // Move lamports.
    let lamports = src.lamports();
    **src.try_borrow_mut_lamports()? = 0;
    **dest.try_borrow_mut_lamports()? = dest
        .lamports()
        .checked_add(lamports)
        .ok_or(error!(SoothCoreError::MathOverflow))?;

    // Zero account data.
    let mut data = src.try_borrow_mut_data()?;
    data.fill(0);

    Ok(())
}
