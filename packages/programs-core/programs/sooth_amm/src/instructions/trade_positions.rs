//! `trade_positions` — buy YES/NO shares against the LMSR.
//!
//! Architecture references:
//!   - §4.2 (buyYes call chain, init_if_needed Position pattern)
//!   - §4.3 (sell with lock-on-sell — handled by the sibling
//!     `sell_positions` ix in this same module)
//!   - §5   (CU budget — ~75-80k projected envelope per spike D4)
//!   - §8   (fee router 4-way split)
//!
//! ## Buy vs sell split
//!
//! The architecture sketch in `architecture.md §4.3` describes a unified
//! `trade_positions` ix that branches on `delta_shares` sign. Anchor's
//! account-loading pass evaluates `init`/`init_if_needed` constraints
//! before the handler runs, which makes a unified ix awkward: the
//! `LockEntry` PDA needed on the sell branch must either be init'd
//! unconditionally (forcing buyers to pay rent on a useless escrow
//! account) or use `init_if_needed` with seeds tied to a per-trade nonce
//! (which means buys and sells contend for the same fresh-PDA slot, and
//! a buy after a sell would fail the seed-equality check).
//!
//! Solana's idiomatic resolution is to split the two ixs. `trade_positions`
//! handles buys only; sells go through `sell_positions` (sibling module),
//! which mirrors the buy account list plus the lock-side accounts. Both
//! ixs mutate the same `AmmState` / `Position`; the SDK's `buildTrade` will
//! dispatch on `delta_shares` sign in a follow-up commit. The
//! `SellNotImplemented` error variant is preserved for SDK compatibility
//! — the surface still rejects sells through this ix.
//!
//! ## Status
//!
//! Buy path is end-to-end real:
//!   - Outcome decoding & validation
//!   - LMSR `cost_delta` (real call into the math module)
//!   - Slippage check vs `max_cost_wad`
//!   - WAD → USDC ceil conversion
//!   - `AmmState.q_yes/q_no` mutation
//!   - `Position.yes_shares/no_shares` mutation
//!   - `spl-token::transfer` user_usdc_ata → market_vault, signed by user
//!   - `PositionTraded` event emission
//!
//! Still stubbed (deliberately scoped out of this commit):
//!   - Fee router CPI / split (architecture §8) — `fee_wad = 0`. The slippage
//!     check `cost_wad + fee_wad ≤ max_cost_wad` therefore degenerates to
//!     `cost_wad ≤ max_cost_wad`, which is **looser** than the EVM check.
//!     Tracked gap until the fee router lands.
//!   - LP mint on pre-graduation buys (architecture §4.2).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothAmmError;
use crate::events::PositionTraded;
use crate::math::{cost_delta, wad_to_usdc_ceil, MathError};
use crate::state::{AmmState, Market, Position};

/// Protocol-wide OUTCOME encoding. Mirrors `glossary.md`.
const OUTCOME_NO: u8 = 0;
const OUTCOME_YES: u8 = 1;

#[derive(Accounts)]
pub struct TradePositions<'info> {
    /// Market PDA — owned by `sooth_market`. The `Account<'info, Market>` type
    /// pins ownership against `sooth_market::ID` (via the `Owner` trait the
    /// `#[account]` macro derives in `sooth_market`); the explicit
    /// `seeds::program` here additionally pins the PDA derivation to
    /// `sooth_market`'s address space so a malicious caller can't forge a
    /// `Market` from a different program's PDA namespace.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Box<Account<'info, Market>>,

    /// Per-market AMM cursor. Seeds match architecture §2.2.
    #[account(
        mut,
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        constraint = amm_state.market == market.key() @ SoothAmmError::MarketNotOpen,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

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
    pub position: Box<Account<'info, Position>>,

    /// Vault authority signer-only PDA owned by `sooth_market`. Declared here
    /// so the `market_vault.token::authority` constraint below has a concrete
    /// account to bind against. The AMM never *signs* with this PDA on the
    /// buy path (the user signs the `Transfer`); declaring it is purely a
    /// constraint anchor.
    /// CHECK: derived via seeds; no data.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
        seeds::program = sooth_market::ID,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// User's USDC ATA — debited on buy, credited on sell.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = user,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// Market USDC vault (ATA owned by `vault_authority`). Constraints close
    /// the hole where any USDC token account could be passed: the vault must
    /// be the canonical USDC mint and must be authority-owned by the
    /// `vault_authority` PDA derived above. Cross-checked against the
    /// `Market` record so a stale/forged ATA is rejected.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = vault_authority,
        constraint = market_vault.key() == market.vault @ SoothAmmError::MarketNotOpen,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// USDC mint reference. Pinned to the canonical cluster USDC via the
    /// `address = ...` constraint so the `token::mint = usdc_mint` checks on
    /// the user/vault ATAs above transitively bind to the same canonical mint.
    /// Devnet value lives in `sooth_amm::USDC_MINT_DEVNET`; the SDK swaps the
    /// constant per cluster at deploy time.
    #[account(address = crate::USDC_MINT_DEVNET)]
    pub usdc_mint: Box<Account<'info, Mint>>,

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

    // Buy-only ix: sells route through `sell_positions` (see module
    // comment "Buy vs sell split"). Returning `SellNotImplemented` here is
    // the SDK-facing signal that the caller used the wrong ix; the SDK's
    // `buildTrade` is expected to dispatch on `delta_shares` sign in a
    // follow-up commit.
    require!(delta_shares > 0, SoothAmmError::SellNotImplemented);

    let market = &ctx.accounts.market;
    require!(market.is_open(), SoothAmmError::MarketNotOpen);

    // C1 (Codex): trading window guard. EVM analogue —
    // `AMMEngine.tradePositions` (`AMMEngine.sol:245-246`):
    //   require(ITruthMarket(market).isLive(), MarketNotLive());
    //   require(block.timestamp < ITruthMarket(market).deadline(), DeadlinePassed());
    // The Solana port adds the symmetric `start_time <= now` check the EVM
    // contract enforces structurally via `BeforeStart()` in `TruthMarket.sol:92`.
    // Without these, a market past its event-resolution deadline is still
    // tradeable — someone holding underpriced winning shares can dump them
    // post-event before the adjudicator settles.
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= market.start_time,
        SoothAmmError::TradingNotStarted
    );
    require!(now < market.deadline, SoothAmmError::TradingClosed);

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
    // Buy-only here (delta_shares > 0); the sell branch lives in
    // `sell_positions`. The other side is unaffected by an AMM trade per
    // binary-outcome LMSR; mint/merge/redeem is a separate `sooth_market` ix.
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
    // against `max_cost_wad`. NOTE: this makes the check **looser** than the
    // EVM contract's `cost + fee ≤ max` — known gap until the fee router
    // lands. The SDK's `max_cost_wad` already reserves headroom.
    let fee_wad: u128 = 0; // todo!("fee router CPI; see architecture §8")

    // ── 4. Slippage check ────────────────────────────────────────────────
    //
    // `cost_wad` is positive on the buy path (we're charged); enforce the
    // SDK's max-cost ceiling.
    require!(cost_wad > 0, SoothAmmError::MathOverflow);
    let total_cost_wad: u128 = (cost_wad as u128)
        .checked_add(fee_wad)
        .ok_or(error!(SoothAmmError::MathOverflow))?;
    require!(
        total_cost_wad <= max_cost_wad,
        SoothAmmError::SlippageExceeded
    );

    // ── 5. WAD → USDC ceil (REAL) ────────────────────────────────────────
    let cost_usdc: u64 = wad_to_usdc_ceil(cost_wad as u128)
        .map_err(map_math_err)?;

    // ── 6. Token transfer (BUY): user_usdc_ata → market_vault ────────────
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.user_usdc_ata.to_account_info(),
            to: ctx.accounts.market_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    );
    token::transfer(cpi_ctx, cost_usdc)?;

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
    if !amm.is_graduated {
        // unimplemented!("LP mint — phase 2; architecture §4.2")
    }

    // ── 9. Emit (REAL) ───────────────────────────────────────────────────
    // `now` is the same `Clock::get()` snapshot used by the C1 trading-window
    // guard above — re-using avoids a second sysvar load (~100 CU) and keeps
    // the emitted timestamp consistent with the guard.
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
