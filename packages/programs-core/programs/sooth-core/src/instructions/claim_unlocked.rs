//! `claim_unlocked` — drain a single `LockEntry` after its 24h lock elapses.
//!
//! Adapted from `sooth_amm::claim_unlocked`. The CPI into
//! `sooth_market::transfer_from_lock_vault` is replaced with a direct
//! PDA-signed `token::transfer` from `lock_vault → user_usdc_ata`, signed by
//! `lock_authority` which is now a PDA owned by this program.
//! `sooth_market_program` and `instruction_sysvar` accounts are removed.
//! `seeds::program` constraints removed.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothCoreError;
use crate::events::LockClaimed;
use crate::state::{LockEntry, Market, Position};

#[derive(Accounts)]
pub struct ClaimUnlocked<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        seeds = [b"pos", market.market_id.as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = user @ SoothCoreError::Unauthorized,
        has_one = market @ SoothCoreError::Unauthorized,
    )]
    pub position: Box<Account<'info, Position>>,

    /// Lock entry to drain + close. Anchor's `close = user` refunds the
    /// rent lamports to `user` and zeroes the discriminator on success.
    #[account(
        mut,
        close = user,
        seeds = [
            b"lock_entry",
            position.key().as_ref(),
            lock_entry.nonce.to_le_bytes().as_ref(),
        ],
        bump = lock_entry.bump,
        has_one = user @ SoothCoreError::Unauthorized,
        has_one = market @ SoothCoreError::Unauthorized,
    )]
    pub lock_entry: Box<Account<'info, LockEntry>>,

    /// CHECK: derived via seeds; signs the lock_vault transfer.
    #[account(
        seeds = [b"lock", market.market_id.as_ref()],
        bump = market.lock_authority_bump,
    )]
    pub lock_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = lock_authority,
        constraint = lock_vault.key() == market.lock_vault @ SoothCoreError::LockVaultMismatch,
    )]
    pub lock_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = user,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(address = crate::constants::BASE_TOKEN_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimUnlocked>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.lock_entry.unlock_at,
        SoothCoreError::LockNotElapsed
    );

    let amount = ctx.accounts.lock_entry.amount_usdc;
    let market_pubkey = ctx.accounts.market.key();
    let lock_entry_pubkey = ctx.accounts.lock_entry.key();
    let user_pubkey = ctx.accounts.user.key();
    let market_id = ctx.accounts.market.market_id;
    let lock_authority_bump = ctx.accounts.market.lock_authority_bump;

    if amount > 0 {
        let signer_seeds: &[&[&[u8]]] =
            &[&[b"lock", market_id.as_ref(), &[lock_authority_bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.lock_vault.to_account_info(),
                    to: ctx.accounts.user_usdc_ata.to_account_info(),
                    authority: ctx.accounts.lock_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    }

    emit!(LockClaimed {
        market: market_pubkey,
        user: user_pubkey,
        lock_entry: lock_entry_pubkey,
        amount_usdc: amount,
        ts: now,
    });

    // LockEntry closed via `close = user` constraint.
    Ok(())
}
