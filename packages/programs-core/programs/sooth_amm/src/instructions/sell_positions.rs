//! `sell_positions` — sell YES/NO shares against the LMSR with lock-on-sell.
//!
//! Architecture §4.3. Sibling of `trade_positions` (which handles buys). See
//! the "Buy vs sell split" comment in `trade_positions.rs` for the rationale
//! for splitting the unified architecture-spec ix into two ixs on Solana.
//!
//! ## Flow (mirrors EVM `_executeSell` / `AMMEngine.sol:981-1014`)
//!
//!   1. LMSR `cost_delta(...)` returns a negative WAD value; absolute value
//!      is the proceeds owed to the seller.
//!   2. Fee is computed from gross proceeds using `ProtocolConfig.fee_bps`;
//!      net proceeds mirror EVM `_quoteFee` sell semantics.
//!   3. Optional slippage check vs net `min_proceeds_wad`; the SDK passes `0`
//!      to skip.
//!   4. Gross/net/fee WAD values are independently floored to USDC atoms; any
//!      rounding residue remains in `market_vault`.
//!   5. Mutate `amm_state.q_yes/q_no` and `position.yes_shares/no_shares`.
//!   6. PDA-signed fee transfer `market_vault -> market_fee_pool`, then
//!      PDA-signed `market_vault -> lock_vault` for net proceeds.
//!   7. `init` `LockEntry` PDA at `[b"lock_entry", position.key(), nonce]`,
//!      where `nonce = position.lock_nonce` *before* increment.
//!   8. Increment `position.lock_nonce`.
//!   9. Emit `PositionSold`.
//!
//! The user later calls `claim_unlocked` (separate ix) to drain the
//! `LockEntry` after `LOCK_DURATION_SECS` has elapsed. Architecture §4.3.
//!
//! ## Slippage parameter
//!
//! `min_proceeds_wad: u128` is the seller-set lower bound on net proceeds
//! after the sell fee. The trade reverts if the user-received proceeds drop
//! below it. `0` disables the check. Mirrors EVM's
//! `_executeSell(..., minProceeds, ...)` after `_quoteFee`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use anchor_spl::token::{Mint, Token, TokenAccount};

use sooth_account_offsets::{
    PROTOCOL_CONFIG_FEE_BPS_OFFSET, PROTOCOL_CONFIG_TOTAL_LEN as PROTOCOL_CONFIG_MIN_LEN,
};
use sooth_market::cpi::accounts::{TransferFeeToMarketPool, TransferToLock};
use sooth_market::program::SoothMarket;

use crate::error::SoothAmmError;
use crate::events::PositionSold;
use crate::math::{cost_delta, wad_to_usdc_floor, MathError};
use crate::state::{AmmState, LockEntry, Market, Position};
use crate::{LOCK_DURATION_SECS, SOOTH_LAUNCHPAD_PROGRAM_ID};

/// Protocol-wide OUTCOME encoding. Mirrors `glossary.md`.
const OUTCOME_NO: u8 = 0;
const OUTCOME_YES: u8 = 1;

#[derive(Accounts)]
pub struct SellPositions<'info> {
    /// Market PDA — owned by `sooth_market`. Mirrors `trade_positions`.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        constraint = amm_state.market == market.key() @ SoothAmmError::MarketNotOpen,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// Per-(user, market) Position. Must already exist — you can only
    /// sell shares you've previously bought, and the buy path is the
    /// only thing that creates a `Position`. Hence plain `mut`, not
    /// `init_if_needed`.
    #[account(
        mut,
        seeds = [b"pos", market.market_id.as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = user @ SoothAmmError::Unauthorized,
        has_one = market @ SoothAmmError::Unauthorized,
    )]
    pub position: Box<Account<'info, Position>>,

    /// Vault authority signer-only PDA. NOT signed-by here anymore — the
    /// PDA is owned by `sooth_market`, so the actual `invoke_signed` happens
    /// inside the `sooth_market::transfer_to_lock` CPI (Wave 1B fix). We
    /// still declare it as an account so we can forward it to the CPI and
    /// so the `market_vault.token::authority` constraint has an anchor.
    /// CHECK: derived via seeds.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
        seeds::program = sooth_market::ID,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Lock-authority signer-only PDA. Constraint anchor for `lock_vault`;
    /// owned by `sooth_market`, signed-with by the
    /// `sooth_market::transfer_to_lock` CPI (not directly here).
    /// CHECK: derived via seeds.
    #[account(
        seeds = [b"lock", market.market_id.as_ref()],
        bump = market.lock_authority_bump,
        seeds::program = sooth_market::ID,
    )]
    pub lock_authority: UncheckedAccount<'info>,

    /// Market USDC vault — debited (USDC → lock_vault). Cross-checked
    /// against `market.vault`.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = vault_authority,
        constraint = market_vault.key() == market.vault @ SoothAmmError::MarketNotOpen,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// AMM lock-on-sell escrow vault — credited. ATA owned by
    /// `lock_authority`; cross-checked against `market.lock_vault`.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = lock_authority,
        constraint = lock_vault.key() == market.lock_vault @ SoothAmmError::LockVaultMismatch,
    )]
    pub lock_vault: Box<Account<'info, TokenAccount>>,

    /// New `LockEntry` PDA. Seeds `[b"lock_entry", position.key(), nonce]`
    /// where `nonce = position.lock_nonce`. The handler increments
    /// `position.lock_nonce` after init so the next sell uses fresh seeds.
    /// `init` (not `init_if_needed`) — by construction the nonce makes
    /// every PDA fresh, so re-init can never be requested.
    #[account(
        init,
        payer = user,
        space = LockEntry::SPACE,
        seeds = [
            b"lock_entry",
            position.key().as_ref(),
            position.lock_nonce.to_le_bytes().as_ref(),
        ],
        bump,
    )]
    pub lock_entry: Box<Account<'info, LockEntry>>,

    /// USDC mint reference. Pinned to the canonical cluster USDC.
    #[account(address = crate::USDC_MINT_DEVNET)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// `ProtocolConfig` PDA owned by `sooth_launchpad`; raw-parsed for fee_bps
    /// to avoid a cyclic dependency on the launchpad crate.
    /// CHECK: address-pinned via PDA seeds + owner constraint.
    #[account(
        seeds = [b"protocol_config"],
        bump,
        seeds::program = SOOTH_LAUNCHPAD_PROGRAM_ID,
        owner = SOOTH_LAUNCHPAD_PROGRAM_ID,
    )]
    pub protocol_config: UncheckedAccount<'info>,

    /// Per-market fee-pool token account credited by the sell fee CPI.
    #[account(
        mut,
        seeds = [b"market_fee_pool", market.market_id.as_ref()],
        bump,
        seeds::program = SOOTH_LAUNCHPAD_PROGRAM_ID,
        token::mint = usdc_mint,
    )]
    pub market_fee_pool: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,

    /// `sooth_market` program — CPI'd into for the PDA-signed
    /// `vault → lock_vault` transfer. Mandatory after the Wave 1B fix.
    pub sooth_market_program: Program<'info, SoothMarket>,

    /// Instructions sysvar — forwarded to `sooth_market::transfer_to_lock`
    /// where it gates against direct (non-CPI) calls via parent-ix
    /// introspection. The AMM doesn't read this account itself; we declare
    /// it solely so Anchor places it on the CPI account list. Pinned to the
    /// canonical sysvar pubkey. CHECK: address-pinned downstream.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<SellPositions>,
    outcome: u8,
    delta_shares: i128,
    min_proceeds_wad: u128,
) -> Result<()> {
    // ── 1. Decode + validate args ────────────────────────────────────────
    require!(
        outcome == OUTCOME_NO || outcome == OUTCOME_YES,
        SoothAmmError::InvalidOutcome
    );
    require!(delta_shares < 0, SoothAmmError::ZeroDelta);

    require!(ctx.accounts.market.is_open(), SoothAmmError::MarketNotOpen);

    // Trading window guard — same as buy path. C1 (Codex) note in
    // `trade_positions.rs` covers the rationale (post-deadline / pre-start
    // sells must be rejected on-chain).
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.market.start_time,
        SoothAmmError::TradingNotStarted
    );
    require!(
        now < ctx.accounts.market.deadline,
        SoothAmmError::TradingClosed
    );

    // Snapshot fields off `market` we'll need after the CPI (the CPI takes
    // `ctx.accounts.market.to_account_info()`, which is fine, but we want
    // to capture pubkey-by-value to use in the LockEntry / event emission
    // without re-borrowing across the CPI).
    let market_key = ctx.accounts.market.key();

    require!(
        !ctx.accounts.amm_state.is_dismissed,
        SoothAmmError::MarketDismissed
    );
    require!(
        ctx.accounts.amm_state.b > 0,
        SoothAmmError::InvalidLiquidity
    );

    // ── 2. Compute LMSR cost delta ───────────────────────────────────────
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

    // For a sell `cost_wad` should be ≤ 0 (proceeds back to user). A
    // non-negative value means LMSR returned cost — the args are wrong.
    require!(cost_wad <= 0, SoothAmmError::MathOverflow);
    let proceeds_wad: u128 = cost_wad.unsigned_abs();

    // ── 3. Fee + slippage check vs net min_proceeds_wad ────────────────────
    //
    // EVM analogue: `FeeRouter._quoteFee` then `_executeSell`
    // `require(netAmount >= minProceeds, ...)`.
    let fee_bps: u16 = {
        let pc_ai = ctx.accounts.protocol_config.to_account_info();
        let data = pc_ai.try_borrow_data()?;
        require!(
            data.len() >= PROTOCOL_CONFIG_MIN_LEN,
            SoothAmmError::MathOverflow
        );
        u16::from_le_bytes(
            data[PROTOCOL_CONFIG_FEE_BPS_OFFSET..PROTOCOL_CONFIG_FEE_BPS_OFFSET + 2]
                .try_into()
                .map_err(|_| error!(SoothAmmError::MathOverflow))?,
        )
    };
    let fee_wad: u128 = proceeds_wad
        .checked_mul(fee_bps as u128)
        .map(|v| v / 10_000)
        .ok_or(error!(SoothAmmError::MathOverflow))?;
    let net_proceeds_wad = proceeds_wad.saturating_sub(fee_wad);

    if min_proceeds_wad > 0 {
        require!(
            net_proceeds_wad >= min_proceeds_wad,
            SoothAmmError::SlippageExceeded
        );
    }

    // ── 4. WAD → USDC floor (REAL) ───────────────────────────────────────
    //
    // Floor (not ceil) on outflow. Fee and net are floored independently; any
    // base-unit residue stays in the market vault.
    let proceeds_usdc_pre_split: u64 = wad_to_usdc_floor(proceeds_wad).map_err(map_math_err)?;
    let fee_usdc: u64 = wad_to_usdc_floor(fee_wad).map_err(map_math_err)?;
    let net_proceeds_usdc: u64 = wad_to_usdc_floor(net_proceeds_wad).map_err(map_math_err)?;
    let vault_outflow_usdc = net_proceeds_usdc
        .checked_add(fee_usdc)
        .ok_or(error!(SoothAmmError::MathOverflow))?;
    require!(
        vault_outflow_usdc <= proceeds_usdc_pre_split,
        SoothAmmError::MathOverflow
    );

    // ── 5. State mutation (scoped — must drop borrows before the CPI) ────
    {
        let amm = &mut ctx.accounts.amm_state;
        let position = &mut ctx.accounts.position;
        if outcome == OUTCOME_YES {
            amm.q_yes = amm
                .q_yes
                .checked_add(delta_shares)
                .ok_or(error!(SoothAmmError::MathOverflow))?;
            position.yes_shares = position
                .yes_shares
                .checked_add(delta_shares)
                .ok_or(error!(SoothAmmError::MathOverflow))?;
            require!(position.yes_shares >= 0, SoothAmmError::InsufficientShares);
        } else {
            amm.q_no = amm
                .q_no
                .checked_add(delta_shares)
                .ok_or(error!(SoothAmmError::MathOverflow))?;
            position.no_shares = position
                .no_shares
                .checked_add(delta_shares)
                .ok_or(error!(SoothAmmError::MathOverflow))?;
            require!(position.no_shares >= 0, SoothAmmError::InsufficientShares);
        }
    }

    // ── 6. CPIs into sooth_market fee + lock helpers ─────────────────────
    //
    // The `vault_authority` PDA is owned by `sooth_market`, so the AMM can't
    // `invoke_signed` against it directly. We delegate the actual transfer
    // (and the PDA signing) to the market-owned helpers. CU envelope: the
    // previous sell path was ~75-80k CU; the extra SPL fee CPI adds ~5k, so
    // the expected path remains under the W2b <=100k target.
    if fee_usdc > 0 {
        let cpi_accounts = TransferFeeToMarketPool {
            market: ctx.accounts.market.to_account_info(),
            market_vault: ctx.accounts.market_vault.to_account_info(),
            market_fee_pool: ctx.accounts.market_fee_pool.to_account_info(),
            vault_authority: ctx.accounts.vault_authority.to_account_info(),
            instruction_sysvar: ctx.accounts.instruction_sysvar.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.sooth_market_program.to_account_info(),
            cpi_accounts,
        );
        sooth_market::cpi::transfer_fee_to_market_pool(cpi_ctx, fee_usdc)?;
    }
    let cpi_accounts = TransferToLock {
        market: ctx.accounts.market.to_account_info(),
        vault_authority: ctx.accounts.vault_authority.to_account_info(),
        vault: ctx.accounts.market_vault.to_account_info(),
        lock_vault: ctx.accounts.lock_vault.to_account_info(),
        position: ctx.accounts.position.to_account_info(),
        usdc_mint: ctx.accounts.usdc_mint.to_account_info(),
        user: ctx.accounts.user.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        instruction_sysvar: ctx.accounts.instruction_sysvar.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(
        ctx.accounts.sooth_market_program.to_account_info(),
        cpi_accounts,
    );
    sooth_market::cpi::transfer_to_lock(cpi_ctx, net_proceeds_usdc)?;

    ctx.accounts.position.locked_cost_usdc = ctx
        .accounts
        .position
        .locked_cost_usdc
        .saturating_sub(vault_outflow_usdc);

    // ── 7. Populate the freshly-init'd LockEntry ─────────────────────────
    let unlock_at = now
        .checked_add(LOCK_DURATION_SECS)
        .ok_or(error!(SoothAmmError::MathOverflow))?;
    let nonce_at_init = ctx.accounts.position.lock_nonce;
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

    // ── 8. Bump the per-Position lock-nonce counter ──────────────────────
    let new_nonce = nonce_at_init
        .checked_add(1)
        .ok_or(error!(SoothAmmError::MathOverflow))?;
    ctx.accounts.position.lock_nonce = new_nonce;

    // ── 9. Emit ─────────────────────────────────────────────────────────
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
    error!(SoothAmmError::MathOverflow)
}
