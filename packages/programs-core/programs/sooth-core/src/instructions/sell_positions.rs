//! `sell_positions` — sell YES/NO shares against the LMSR with lock-on-sell.
//!
//! Uses PDA-signed token transfers:
//!   - `token::transfer(market_vault → market_fee_pool)`.
//!   - `token::transfer(market_vault → lock_vault)`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothCoreError;
use crate::events::PositionSold;
use crate::math::{cost_delta, wad_to_usdc_floor, MathError};
use crate::state::{AmmState, LockEntry, Market, Position, ProtocolConfig};

const LOCK_DURATION_SECS: i64 = 24 * 60 * 60;

const OUTCOME_NO: u8 = 0;
const OUTCOME_YES: u8 = 1;

#[derive(Accounts)]
#[instruction(_outcome: u8, _delta_shares: i128, _min_proceeds_wad: u128, lock_nonce: u64)]
pub struct SellPositions<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        constraint = amm_state.market == market.key() @ SoothCoreError::MarketNotOpen,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// Per-(user, market) Position. Must already exist — you can only
    /// sell shares you've previously bought.
    #[account(
        mut,
        seeds = [b"pos", market.market_id.as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = user @ SoothCoreError::Unauthorized,
        has_one = market @ SoothCoreError::Unauthorized,
    )]
    pub position: Box<Account<'info, Position>>,

    /// CHECK: derived via seeds; signs the vault outflow CPIs.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: derived via seeds; signs the lock_vault outflow.
    #[account(
        seeds = [b"lock", market.market_id.as_ref()],
        bump = market.lock_authority_bump,
    )]
    pub lock_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = vault_authority,
        constraint = market_vault.key() == market.vault @ SoothCoreError::MarketNotOpen,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = lock_authority,
        constraint = lock_vault.key() == market.lock_vault @ SoothCoreError::LockVaultMismatch,
    )]
    pub lock_vault: Box<Account<'info, TokenAccount>>,

    /// New `LockEntry` PDA. Seeds `[b"lock_entry", position.key(), lock_nonce.to_le_bytes()]`.
    /// The `lock_nonce` instruction parameter must equal `position.lock_nonce`.
    #[account(
        init,
        payer = user,
        space = LockEntry::SPACE,
        seeds = [
            b"lock_entry",
            position.key().as_ref(),
            &lock_nonce.to_le_bytes(),
        ],
        bump,
    )]
    pub lock_entry: Box<Account<'info, LockEntry>>,

    #[account(address = crate::constants::BASE_TOKEN_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [b"market_fee_pool", market.market_id.as_ref()],
        bump,
        token::mint = usdc_mint,
    )]
    pub market_fee_pool: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<SellPositions>,
    outcome: u8,
    delta_shares: i128,
    min_proceeds_wad: u128,
    lock_nonce: u64,
) -> Result<()> {
    require!(
        outcome == OUTCOME_NO || outcome == OUTCOME_YES,
        SoothCoreError::InvalidOutcome
    );
    require!(delta_shares < 0, SoothCoreError::ZeroDelta);
    // Verify the caller-supplied lock_nonce matches the current position nonce.
    require_eq!(
        lock_nonce,
        ctx.accounts.position.lock_nonce,
        SoothCoreError::OrderIdSeedMismatch
    );

    require!(ctx.accounts.market.is_open(), SoothCoreError::MarketNotOpen);

    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.market.start_time,
        SoothCoreError::TradingNotStarted
    );
    require!(
        now < ctx.accounts.market.deadline,
        SoothCoreError::TradingClosed
    );

    let market_key = ctx.accounts.market.key();
    let market_id = ctx.accounts.market.market_id;

    require!(
        !ctx.accounts.amm_state.is_dismissed,
        SoothCoreError::MarketDismissed
    );
    require!(ctx.accounts.amm_state.b > 0, SoothCoreError::InvalidLiquidity);

    let (d_yes, d_no) = if outcome == OUTCOME_YES {
        (delta_shares, 0i128)
    } else {
        (0i128, delta_shares)
    };

    let cost_wad: i128 = cost_delta(
        ctx.accounts.amm_state.q_yes,
        ctx.accounts.amm_state.q_no,
        ctx.accounts.amm_state.b,
        d_yes,
        d_no,
    )
    .map_err(map_math_err)?;

    require!(cost_wad <= 0, SoothCoreError::MathOverflow);
    let proceeds_wad: u128 = cost_wad.unsigned_abs();

    let fee_bps = ctx.accounts.protocol_config.fee_bps;
    let fee_wad: u128 = proceeds_wad
        .checked_mul(fee_bps as u128)
        .map(|v| v / 10_000)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    let net_proceeds_wad = proceeds_wad.saturating_sub(fee_wad);

    if min_proceeds_wad > 0 {
        require!(
            net_proceeds_wad >= min_proceeds_wad,
            SoothCoreError::SlippageExceeded
        );
    }

    let proceeds_usdc_pre_split: u64 = wad_to_usdc_floor(proceeds_wad).map_err(map_math_err)?;
    let fee_usdc: u64 = wad_to_usdc_floor(fee_wad).map_err(map_math_err)?;
    let net_proceeds_usdc: u64 = wad_to_usdc_floor(net_proceeds_wad).map_err(map_math_err)?;
    let vault_outflow_usdc = net_proceeds_usdc
        .checked_add(fee_usdc)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    require!(
        vault_outflow_usdc <= proceeds_usdc_pre_split,
        SoothCoreError::MathOverflow
    );

    // ── 5. State mutation ─────────────────────────────────────────────────
    {
        let amm = &mut ctx.accounts.amm_state;
        let position = &mut ctx.accounts.position;
        if outcome == OUTCOME_YES {
            amm.q_yes = amm
                .q_yes
                .checked_add(delta_shares)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
            position.yes_shares = position
                .yes_shares
                .checked_add(delta_shares)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
            require!(position.yes_shares >= 0, SoothCoreError::InsufficientShares);
        } else {
            amm.q_no = amm
                .q_no
                .checked_add(delta_shares)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
            position.no_shares = position
                .no_shares
                .checked_add(delta_shares)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
            require!(position.no_shares >= 0, SoothCoreError::InsufficientShares);
        }
    }

    // ── 6. PDA-signed fee transfer: market_vault → market_fee_pool ────────
    let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
    let vault_signer_seeds: &[&[&[u8]]] =
        &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

    if fee_usdc > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.market_fee_pool.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                vault_signer_seeds,
            ),
            fee_usdc,
        )?;
    }

    // ── 6b. PDA-signed net transfer: market_vault → lock_vault ────────────
    if net_proceeds_usdc > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.lock_vault.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                vault_signer_seeds,
            ),
            net_proceeds_usdc,
        )?;
    }

    ctx.accounts.position.locked_cost_usdc = ctx
        .accounts
        .position
        .locked_cost_usdc
        .saturating_sub(vault_outflow_usdc);

    // ── 7. Populate the LockEntry ─────────────────────────────────────────
    let unlock_at = now
        .checked_add(LOCK_DURATION_SECS)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    let nonce_at_init = lock_nonce; // validated == position.lock_nonce above
    let lock_entry_bump = ctx.bumps.lock_entry;
    let user_key = ctx.accounts.user.key();
    {
        let lock_entry = &mut ctx.accounts.lock_entry;
        lock_entry.user = user_key;
        lock_entry.market = market_key;
        lock_entry.amount_usdc = net_proceeds_usdc;
        lock_entry.unlock_at = unlock_at;
        lock_entry.nonce = nonce_at_init;
        lock_entry.bump = lock_entry_bump;
    }

    // ── 8. Bump the lock-nonce counter ────────────────────────────────────
    let new_nonce = nonce_at_init
        .checked_add(1)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    ctx.accounts.position.lock_nonce = new_nonce;

    // ── 9. Emit ───────────────────────────────────────────────────────────
    let lock_entry_key = ctx.accounts.lock_entry.key();
    emit!(PositionSold {
        market: market_key,
        user: user_key,
        outcome,
        shares_sold: delta_shares.unsigned_abs(),
        lock_entry: lock_entry_key,
        amount_usdc: net_proceeds_usdc,
        unlock_at,
    });

    Ok(())
}

fn map_math_err(_e: MathError) -> Error {
    error!(SoothCoreError::MathOverflow)
}
