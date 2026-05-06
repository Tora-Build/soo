//! `trade_positions` — buy or sell YES/NO shares against the LMSR.
//!
//! Architecture references:
//!   - §4.2 (buyYes call chain, init_if_needed Position pattern)
//!   - §4.3 (sell with lock-on-sell, separate `claim_unlocked` ix)
//!   - §5   (CU budget — ~75-80k projected envelope per spike D4)
//!   - §8   (fee router 4-way split)
//!
//! ## Status
//!
//! This scaffold has the **load-bearing** pieces wired in:
//!   - Outcome decoding & validation
//!   - LMSR `cost_delta` (real call into the math module)
//!   - Slippage check vs `max_cost_wad`
//!   - WAD → USDC ceil conversion
//!   - `AmmState.q_yes/q_no` mutation
//!   - `Position.yes_shares/no_shares` mutation
//!   - `PositionTraded` event emission
//!
//! And leaves these as `todo!()` / `unimplemented!()`:
//!   - Fee router CPI / split (architecture §8)
//!   - `spl-token::transfer` from user ATA → market vault (architecture §4.2)
//!   - LP mint on pre-graduation buys (architecture §4.2)
//!   - Lock-on-sell flow (`LockEntry` init + token transfer to lock vault per §4.3)
//!
//! Once the fee router lives in `sooth_launchpad` and `sooth_market` owns the
//! vault PDA, the CPIs below become real and this scaffold becomes the
//! production handler.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::SoothAmmError;
use crate::events::PositionTraded;
use crate::math::{cost_delta, wad_to_usdc_ceil, MathError};
use crate::state::{AmmState, Market, Position};

/// Protocol-wide OUTCOME encoding. Mirrors `glossary.md`.
const OUTCOME_NO: u8 = 0;
const OUTCOME_YES: u8 = 1;

#[derive(Accounts)]
pub struct TradePositions<'info> {
    /// Market PDA — owned by `sooth_market` once that program exists. We only
    /// read it here to gate on lifecycle (`is_live()`).
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// Per-market AMM cursor. Seeds match architecture §2.2.
    #[account(
        mut,
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        constraint = amm_state.market == market.key() @ SoothAmmError::MarketNotLive,
    )]
    pub amm_state: Account<'info, AmmState>,

    /// Per-(user, market) Position. Lazily created on first trade per
    /// architecture §4.2 — `init_if_needed` keeps the surface single-ix from
    /// the SDK's perspective.
    #[account(
        init_if_needed,
        payer = user,
        space = Position::SPACE,
        seeds = [b"pos", market.market_id.as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,

    /// User's USDC ATA — debited on buy, credited on sell.
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc_ata: Account<'info, TokenAccount>,

    /// Market vault ATA — owned by the market PDA. Architecture §2.2.
    #[account(mut, token::mint = usdc_mint)]
    pub market_vault: Account<'info, TokenAccount>,

    /// USDC mint reference. Pinned by the SDK to the canonical mainnet USDC
    /// (`EPjFW...`) or the cluster-appropriate devnet faucet equivalent.
    pub usdc_mint: Account<'info, Mint>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<TradePositions>,
    outcome: u8,
    delta_shares: i128,
    max_cost_wad: u128,
) -> Result<()> {
    // ── 1. Decode + validate args ────────────────────────────────────────
    require!(
        outcome == OUTCOME_NO || outcome == OUTCOME_YES,
        SoothAmmError::InvalidOutcome
    );
    require!(delta_shares != 0, SoothAmmError::ZeroDelta);

    let market = &ctx.accounts.market;
    require!(market.is_live(), SoothAmmError::MarketNotLive);

    let amm = &mut ctx.accounts.amm_state;
    require!(!amm.is_dismissed, SoothAmmError::MarketDismissed);
    require!(amm.b > 0, SoothAmmError::InvalidLiquidity);

    // Pin the position bump so `init_if_needed` works on subsequent trades.
    let position = &mut ctx.accounts.position;
    if position.user == Pubkey::default() {
        position.user = ctx.accounts.user.key();
        position.market = market.key();
        position.bump = ctx.bumps.position;
    }

    // ── 2. Compute LMSR cost delta (REAL — the load-bearing math) ────────
    //
    // `delta_shares > 0` = buy that side; `< 0` = sell. The other side is
    // unaffected by an AMM trade (per binary-outcome LMSR; mint/merge/redeem
    // is a separate `sooth_market` ix).
    let (d_yes, d_no) = if outcome == OUTCOME_YES {
        (delta_shares, 0i128)
    } else {
        (0i128, delta_shares)
    };

    let cost_wad: i128 = cost_delta(amm.q_yes, amm.q_no, amm.b, d_yes, d_no)
        .map_err(map_math_err)?;

    // ── 3. Fee split — STUB ──────────────────────────────────────────────
    //
    // TODO(architecture §8): CPI into `sooth_launchpad::fee_router::split`
    // (4-way: 50% bBase / 30% LP / 10% adjudicator / 10% protocol). Until
    // that program exists we treat fee_wad as 0 and only check `cost_wad`
    // against `max_cost_wad`. Re-introduce the addition once the router is
    // in place — the SDK's `max_cost_wad` already reserves headroom.
    let fee_wad: u128 = 0; // todo!("fee router CPI; see architecture §8")

    // ── 4. Slippage check (against the cost-with-fee, signed) ────────────
    //
    // Sells return negative `cost_wad`; the slippage check applies only to
    // buys (positive). For sells the SDK passes max_cost_wad = u128::MAX.
    if cost_wad > 0 {
        let total_cost_wad: u128 = (cost_wad as u128)
            .checked_add(fee_wad)
            .ok_or(error!(SoothAmmError::MathOverflow))?;
        require!(
            total_cost_wad <= max_cost_wad,
            SoothAmmError::SlippageExceeded
        );
    }

    // ── 5. WAD → USDC ceil (REAL) ────────────────────────────────────────
    //
    // For buys this is what the user pays in USDC base units. For sells
    // it's the absolute proceeds (sign carried separately).
    let _cost_usdc: u64 = wad_to_usdc_ceil(cost_wad.unsigned_abs())
        .map_err(map_math_err)?;

    // ── 6. Token transfer — STUB ─────────────────────────────────────────
    //
    // BUY: CPI `spl-token::transfer(user_usdc_ata → market_vault, cost_usdc)`
    //      with `Signer = user`. Standard `anchor_spl::token::transfer`
    //      pattern. Architecture §4.2.
    //
    // SELL: open a `LockEntry` PDA (architecture §4.3 / §2.3) and CPI
    //       `spl-token::transfer(market_vault → lock_vault, cost_usdc)`
    //       signed by the market PDA. The lock_vault is itself a PDA-owned
    //       ATA that `claim_unlocked` drains after 24h.
    //
    // Neither is wired here because:
    //   (a) `market_vault` and `lock_vault` PDAs/ATAs are owned by
    //       `sooth_market`, which doesn't exist yet.
    //   (b) The fee router CPI in step 3 is also stubbed and any real token
    //       transfer needs to net the fee out first.
    //
    // todo!("CPI to spl-token::transfer; see architecture §4.2 / §4.3")

    // ── 7. State mutation (REAL) ─────────────────────────────────────────
    if outcome == OUTCOME_YES {
        amm.q_yes = amm.q_yes.checked_add(delta_shares).ok_or(error!(SoothAmmError::MathOverflow))?;
        position.yes_shares = position
            .yes_shares
            .checked_add(delta_shares)
            .ok_or(error!(SoothAmmError::MathOverflow))?;
        require!(position.yes_shares >= 0, SoothAmmError::InsufficientShares);
    } else {
        amm.q_no = amm.q_no.checked_add(delta_shares).ok_or(error!(SoothAmmError::MathOverflow))?;
        position.no_shares = position
            .no_shares
            .checked_add(delta_shares)
            .ok_or(error!(SoothAmmError::MathOverflow))?;
        require!(position.no_shares >= 0, SoothAmmError::InsufficientShares);
    }

    // ── 8. LP mint on pre-graduation buys — STUB ─────────────────────────
    //
    // Architecture §4.2: pre-graduation, every buy mints LP tokens 1:1 with
    // cost_wad. Post-graduation, no LP mint and the fee split kicks in.
    // Owned by `sooth_launchpad::LpMint` PDA — wire this once the launchpad
    // program exists.
    if !amm.is_graduated && delta_shares > 0 {
        // unimplemented!("LP mint — phase 2; architecture §4.2")
    }

    // ── 9. Emit (REAL) ───────────────────────────────────────────────────
    let now = Clock::get()?.unix_timestamp;
    emit!(PositionTraded {
        market: market.key(),
        user: ctx.accounts.user.key(),
        outcome,
        delta_shares,
        cost_wad,
        ts: now,
    });

    Ok(())
}

fn map_math_err(_e: MathError) -> Error {
    error!(SoothAmmError::MathOverflow)
}
