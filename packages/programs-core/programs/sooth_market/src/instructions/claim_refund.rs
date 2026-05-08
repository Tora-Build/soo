//! `claim_refund` -- refund a dismissed-market AMM Position.
//!
//! This is the user-facing half of the dismissal refund flow. `sooth_market`
//! owns the market vault authority, so it performs the PDA-signed USDC
//! transfer from `market_vault` to the user. It then CPIs into
//! `sooth_amm::close_dismissed_position` to close the AMM-owned Position and
//! return rent to the user.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::sysvar;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use sooth_account_offsets::{
    POSITION_LOCKED_COST_USDC_OFFSET, POSITION_MARKET_OFFSET,
    POSITION_TOTAL_LEN as POSITION_MIN_LEN, POSITION_USER_OFFSET,
};

use crate::error::SoothMarketError;
use crate::events::RefundClaimed;
use crate::state::Market;
use crate::{SOOTH_AMM_PROGRAM_ID, USDC_MINT_DEVNET};

const AMM_STATE_MARKET_OFFSET: usize = 8;
const AMM_STATE_IS_DISMISSED_OFFSET: usize = 145;
const AMM_STATE_TOTAL_LEN: usize = 147;
const CLOSE_DISMISSED_POSITION_DISCRIMINATOR: [u8; 8] = [247, 68, 107, 180, 228, 202, 14, 5];

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// AMM state is owned by `sooth_amm`; this program validates owner, PDA,
    /// backlink, and the raw `is_dismissed` byte before moving funds.
    /// CHECK: owner/seed/data validated in handler.
    #[account(
        seeds = [b"amm", market.market_id.as_ref()],
        bump,
        seeds::program = SOOTH_AMM_PROGRAM_ID,
        owner = SOOTH_AMM_PROGRAM_ID,
    )]
    pub amm_state: UncheckedAccount<'info>,

    /// Vault authority signer-only PDA owned by this program.
    /// CHECK: derived via seeds.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault @ SoothMarketError::VaultAuthorityMismatch,
        constraint = market_vault.mint == USDC_MINT_DEVNET
            @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = user,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// AMM Position account. The account is owner/seed/raw-field checked in
    /// this handler, then closed by the AMM CPI.
    /// CHECK: owner/seed/data validated in handler.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    #[account(address = USDC_MINT_DEVNET)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,

    /// AMM program, invoked manually to avoid a Cargo cycle.
    /// CHECK: address-pinned.
    #[account(address = SOOTH_AMM_PROGRAM_ID)]
    pub sooth_amm_program: UncheckedAccount<'info>,

    /// Instructions sysvar forwarded to the AMM close helper.
    /// CHECK: address-pinned.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<ClaimRefund>) -> Result<()> {
    let market_id = ctx.accounts.market.market_id;
    let market_key = ctx.accounts.market.key();
    let user_key = ctx.accounts.user.key();

    validate_amm_state(&ctx.accounts.amm_state, &market_key)?;
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

    close_position_via_amm(&ctx)?;

    emit!(RefundClaimed {
        market: market_key,
        user: user_key,
        amount_usdc: locked_cost_usdc,
    });

    Ok(())
}

fn validate_amm_state(amm_state: &UncheckedAccount, market_key: &Pubkey) -> Result<()> {
    require_keys_eq!(
        *amm_state.to_account_info().owner,
        SOOTH_AMM_PROGRAM_ID,
        SoothMarketError::VaultAuthorityMismatch
    );
    let data = amm_state.try_borrow_data()?;
    require!(
        data.len() >= AMM_STATE_TOTAL_LEN,
        SoothMarketError::VaultAuthorityMismatch
    );
    let amm_market = Pubkey::new_from_array(
        data[AMM_STATE_MARKET_OFFSET..AMM_STATE_MARKET_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(SoothMarketError::VaultAuthorityMismatch))?,
    );
    let is_dismissed = data[AMM_STATE_IS_DISMISSED_OFFSET] != 0;
    drop(data);

    require_keys_eq!(
        amm_market,
        *market_key,
        SoothMarketError::VaultAuthorityMismatch
    );
    require!(is_dismissed, SoothMarketError::MarketNotDismissed);
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
        &SOOTH_AMM_PROGRAM_ID,
    );
    require_keys_eq!(
        position.key(),
        expected_position,
        SoothMarketError::VaultAuthorityMismatch
    );
    require_keys_eq!(
        *position.to_account_info().owner,
        SOOTH_AMM_PROGRAM_ID,
        SoothMarketError::VaultAuthorityMismatch
    );

    let data = position.try_borrow_data()?;
    require!(
        data.len() >= POSITION_MIN_LEN,
        SoothMarketError::VaultAuthorityMismatch
    );
    let pos_user = Pubkey::new_from_array(
        data[POSITION_USER_OFFSET..POSITION_USER_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(SoothMarketError::VaultAuthorityMismatch))?,
    );
    let pos_market = Pubkey::new_from_array(
        data[POSITION_MARKET_OFFSET..POSITION_MARKET_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(SoothMarketError::VaultAuthorityMismatch))?,
    );
    let locked_cost_usdc = u64::from_le_bytes(
        data[POSITION_LOCKED_COST_USDC_OFFSET..POSITION_LOCKED_COST_USDC_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(SoothMarketError::VaultAuthorityMismatch))?,
    );
    drop(data);

    require_keys_eq!(
        pos_user,
        *user_key,
        SoothMarketError::VaultAuthorityMismatch
    );
    require_keys_eq!(
        pos_market,
        *market_key,
        SoothMarketError::VaultAuthorityMismatch
    );
    Ok(locked_cost_usdc)
}

fn close_position_via_amm(ctx: &Context<ClaimRefund>) -> Result<()> {
    let close_accounts = vec![
        AccountMeta::new(ctx.accounts.user.key(), true),
        AccountMeta::new_readonly(ctx.accounts.market.key(), false),
        AccountMeta::new_readonly(ctx.accounts.amm_state.key(), false),
        AccountMeta::new(ctx.accounts.position.key(), false),
        AccountMeta::new_readonly(ctx.accounts.instruction_sysvar.key(), false),
    ];
    let ix = Instruction {
        program_id: SOOTH_AMM_PROGRAM_ID,
        accounts: close_accounts,
        data: CLOSE_DISMISSED_POSITION_DISCRIMINATOR.to_vec(),
    };

    invoke(
        &ix,
        &[
            ctx.accounts.user.to_account_info(),
            ctx.accounts.market.to_account_info(),
            ctx.accounts.amm_state.to_account_info(),
            ctx.accounts.position.to_account_info(),
            ctx.accounts.instruction_sysvar.to_account_info(),
            ctx.accounts.sooth_amm_program.to_account_info(),
        ],
    )?;

    Ok(())
}
