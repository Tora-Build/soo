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
//! Wave 1C-fee landed:
//!   - Reads `ProtocolConfig.fee_bps` raw from account data (the cyclic
//!     path-dep `sooth_amm → sooth_launchpad` is forbidden — see
//!     `lib.rs::SOOTH_LAUNCHPAD_PROGRAM_ID` rationale).
//!   - Computes `fee_wad = cost_wad * fee_bps / 10_000` (floor, mirrors
//!     EVM `_quoteFee` line 421).
//!   - Slippage check now uses `cost_wad + fee_wad ≤ max_cost_wad`
//!     (matches the EVM contract's `actualCost = baseCost + fee`).
//!   - Two SPL transfers: `cost_usdc → market_vault` (collateral) and
//!     `fee_usdc → fee_pool_vault` (drained later by
//!     `sooth_launchpad::distribute_fees`). See that ix's docstring for
//!     the pool-then-distribute rationale.
//!   - Pre/post-graduation use the SAME `fee_bps` — architecture §8
//!     collapses `preGradFeeBps`/`postGradFeeBps` into one field; the
//!     pre/post difference lives in the **destination** split, which is
//!     applied at `distribute_fees` time, not here.
//!
//! Still stubbed (deliberately scoped out of this commit):
//!   - LP mint on pre-graduation buys (architecture §4.2) — landing in
//!     `sooth_launchpad::seed_lp`.
//!
//! ## Sells & fees
//!
//! Per the EVM `FeeRouter._quoteFee` (`FeeRouter.sol:415-423`), sells DO
//! pay fees: `netAmount = baseCost - fee` on sell. The Solana port's
//! `sell_positions` ix is intentionally NOT updated in this commit (the
//! Wave 1C scope explicitly excludes the sell path from fee wiring). The
//! gap is tracked: `sell_positions` produces 0 fee revenue today, which
//! makes the protocol slightly under-collected on round-trip trades.
//! See the "Pre-/post-graduation tier handling" note in the ix-level
//! handover — wiring `sell_positions` to debit `fee_pool_vault` mirrors
//! this exact path with `Transfer { from: market_vault, to: fee_pool_vault, … }`
//! signed by `vault_authority` (which means the helper must live in
//! `sooth_market`, since only it can sign for `vault_authority`).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::sysvar;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use sooth_account_offsets::{
    PROTOCOL_CONFIG_FEE_BPS_OFFSET, PROTOCOL_CONFIG_TOTAL_LEN as PROTOCOL_CONFIG_MIN_LEN,
};

use crate::error::SoothAmmError;
use crate::events::{MarketGraduated, PositionTraded};
use crate::math::{cost_delta, wad_mul, wad_to_usdc_ceil, MathError, LN2_WAD};
use crate::state::{AmmState, Market, Position};
use crate::SOOTH_LAUNCHPAD_PROGRAM_ID;

/// Anchor discriminator for `sooth_launchpad::mint_lp_for_buy`. Pinned here
/// rather than imported from `sooth_protocol_types` so the constant lives
/// adjacent to the call site that consumes it. Matches
/// `sha256("global:mint_lp_for_buy")[..8]` and the IDL entry on
/// `sooth_launchpad`.
const MINT_LP_FOR_BUY_DISCRIMINATOR: [u8; 8] = [45, 61, 27, 158, 134, 162, 204, 168];

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

    /// `ProtocolConfig` PDA — singleton owned by `sooth_launchpad`. Source
    /// of `fee_bps` (the only fee field — pre/post-graduation collapse to
    /// one bps per architecture §8) and the four destination split bps
    /// used downstream by `distribute_fees`.
    ///
    /// Typed as `UncheckedAccount` (not `Account<'info, sooth_launchpad::ProtocolConfig>`)
    /// because a path dep `sooth_amm → sooth_launchpad` would close the
    /// existing `sooth_launchpad → sooth_amm` cycle (the launchpad needs
    /// `sooth_amm` for `create_market`'s composition CPI). Same workaround
    /// pattern used by `sooth_market`'s `Position` raw-byte parsing — the
    /// `sooth-account-offsets` crate is the single source of truth for
    /// the byte layout.
    ///
    /// Two layered binding gates:
    ///   1. `seeds = [b"protocol_config"]` + `seeds::program =
    ///      SOOTH_LAUNCHPAD_PROGRAM_ID` — pins the address to the canonical
    ///      singleton.
    ///   2. `owner = SOOTH_LAUNCHPAD_PROGRAM_ID` — guards against a forged
    ///      account at the same address with malicious bytes (defense in
    ///      depth; the seeds check would also catch this for a real PDA).
    ///
    /// CHECK: address-pinned via PDA seeds + owner constraint.
    #[account(
        seeds = [b"protocol_config"],
        bump,
        seeds::program = SOOTH_LAUNCHPAD_PROGRAM_ID,
        owner = SOOTH_LAUNCHPAD_PROGRAM_ID,
    )]
    pub protocol_config: UncheckedAccount<'info>,

    /// Global fee-pool USDC ATA. Credited with the per-trade `fee_usdc`
    /// slice on every buy; drained later by `sooth_launchpad::distribute_fees`.
    /// Owner = `fee_pool_authority` PDA (signer-only PDA owned by
    /// `sooth_launchpad`, seeds `[b"fee_pool_authority"]`). This authority
    /// is opaque to `sooth_amm` — we just push USDC into the ATA, the
    /// launchpad signs the drain.
    ///
    /// The single global pool (vs per-market pools) is documented in
    /// `sooth_launchpad::distribute_fees`'s module comment.
    #[account(
        mut,
        token::mint = usdc_mint,
    )]
    pub fee_pool_vault: Box<Account<'info, TokenAccount>>,

    /// Per-market LP token mint owned by `sooth_launchpad`. Address pinned
    /// via PDA seeds under the launchpad program so a forged mint can't be
    /// substituted. CPI'd into `sooth_launchpad::mint_lp_for_buy` on the
    /// pre-graduation buy path. Architecture §4.2.
    #[account(
        mut,
        seeds = [b"lp", market.market_id.as_ref()],
        bump,
        seeds::program = SOOTH_LAUNCHPAD_PROGRAM_ID,
    )]
    pub lp_mint: Box<Account<'info, Mint>>,

    /// Signer-only PDA owned by `sooth_launchpad`. Mint authority on
    /// `lp_mint`; only the launchpad can `invoke_signed` against it. We
    /// declare it here so the CPI account-list flatten step can forward
    /// it to `mint_lp_for_buy`. CHECK: derived via seeds.
    #[account(
        seeds = [b"lp_mint_authority", market.market_id.as_ref()],
        bump,
        seeds::program = SOOTH_LAUNCHPAD_PROGRAM_ID,
    )]
    pub lp_mint_authority: UncheckedAccount<'info>,

    /// User's LP-token ATA — destination of the `mint_to` CPI inside
    /// `sooth_launchpad::mint_lp_for_buy`. Authority must be `user`; mint
    /// must be `lp_mint`. The SDK pre-creates this ATA idempotently before
    /// dispatching `trade_positions` (mirrors the user_usdc_ata pattern).
    #[account(
        mut,
        token::mint = lp_mint,
        token::authority = user,
    )]
    pub user_lp_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,

    /// `sooth_launchpad` program — CPI'd into for the PDA-signed LP-mint on
    /// the pre-graduation buy path. Address-pinned to the canonical
    /// launchpad ID to prevent a forged program substitution. Note: we
    /// can't take a `Program<'info, SoothLaunchpad>` typed handle here
    /// because that would close a path-dep cycle (`sooth_launchpad` already
    /// depends on `sooth_amm` via the `cpi` feature). The CPI is therefore
    /// constructed manually via `solana_program::program::invoke` against
    /// this `UncheckedAccount`. CHECK: address-pinned.
    #[account(address = SOOTH_LAUNCHPAD_PROGRAM_ID)]
    pub sooth_launchpad_program: UncheckedAccount<'info>,

    /// Instructions sysvar — forwarded to `sooth_launchpad::mint_lp_for_buy`
    /// where it gates against direct (non-CPI) calls via parent-ix
    /// introspection. The AMM doesn't read this account itself; we declare
    /// it solely so it ends up on the CPI account list. Pinned to the
    /// canonical sysvar pubkey via the `address` constraint so a malicious
    /// caller cannot substitute a forged sysvar with a fabricated
    /// instruction list. CHECK: address-pinned.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
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
    require!(now >= market.start_time, SoothAmmError::TradingNotStarted);
    require!(now < market.deadline, SoothAmmError::TradingClosed);

    // Snapshot AmmState fields used downstream + run pre-flight invariants.
    // We re-borrow `amm_state` mutably later (scoped) to apply the
    // `q_yes/q_no` mutation, but read-only access for the LMSR math is
    // taken via the snapshot to avoid a borrow conflict with the LP-mint
    // CPI's `ctx.accounts.position.to_account_info()` later in the body.
    let (amm_q_yes, amm_q_no, amm_b, amm_is_graduated) = {
        let amm = &ctx.accounts.amm_state;
        require!(!amm.is_dismissed, SoothAmmError::MarketDismissed);
        require!(amm.b > 0, SoothAmmError::InvalidLiquidity);
        (amm.q_yes, amm.q_no, amm.b, amm.is_graduated)
    };

    // Pin the position bump so `init_if_needed` works on subsequent trades.
    // Scoped: the mutable borrow is released before the LP-mint CPI below
    // (which reborrows `position` via `to_account_info`).
    let market_key = market.key();
    let user_key = ctx.accounts.user.key();
    let position_bump = ctx.bumps.position;
    {
        let position = &mut ctx.accounts.position;
        if position.user == Pubkey::default() {
            position.user = user_key;
            position.market = market_key;
            position.bump = position_bump;
        }
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

    let cost_wad: i128 =
        cost_delta(amm_q_yes, amm_q_no, amm_b, d_yes, d_no).map_err(map_math_err)?;

    // ── 3. Fee — read fee_bps from ProtocolConfig and compute fee_wad ────
    //
    // EVM analogue: `FeeRouter._quoteFee` (`FeeRouter.sol:415-423`):
    //   fee = (baseCost * bps) / BPS_DENOMINATOR
    //
    // Floor division. Pre/post-graduation collapse to a single `fee_bps`
    // field on `ProtocolConfig` (architecture §8). The pre/post difference
    // lives in the **destinations** split, applied downstream in
    // `sooth_launchpad::distribute_fees`. So this site doesn't branch on
    // `amm.is_graduated`.
    //
    // ProtocolConfig is parsed raw from account data via the offsets in
    // `sooth-account-offsets`. The Anchor account constraints above
    // (seeds = [b"protocol_config"] + owner = SOOTH_LAUNCHPAD_PROGRAM_ID)
    // already pin this to the canonical singleton; the raw-byte read here
    // is just deserialising the `fee_bps: u16` field.
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

    // `cost_wad` is positive on the buy path (we're charged); the check
    // below pins it before the cast to u128.
    require!(cost_wad > 0, SoothAmmError::MathOverflow);
    let fee_wad: u128 = (cost_wad as u128)
        .checked_mul(fee_bps as u128)
        .map(|v| v / 10_000)
        .ok_or(error!(SoothAmmError::MathOverflow))?;

    // ── 4. Slippage check ────────────────────────────────────────────────
    //
    // EVM analogue: `AMMEngine.tradePositions` line 305-306:
    //   actualCost = baseCost + fee;
    //   require(actualCost <= maxCostOrMinProceeds, CostTooHigh());
    //
    // The Solana check is now byte-for-byte equivalent (the Wave 1C-pre
    // looser `cost_wad ≤ max_cost_wad` is gone now that fee_wad is real).
    let total_cost_wad: u128 = (cost_wad as u128)
        .checked_add(fee_wad)
        .ok_or(error!(SoothAmmError::MathOverflow))?;
    require!(
        total_cost_wad <= max_cost_wad,
        SoothAmmError::SlippageExceeded
    );

    // ── 5. WAD → USDC ceil for both legs (REAL) ──────────────────────────
    //
    // Inflow rounding rule: ceil. EVM `_wadToBaseToken` rounds via `(wad +
    // 1e12 - 1) / 1e12` on inflow paths (cost) — see the rationale in
    // `wad.rs::wad_to_usdc_ceil`. Apply the same rule to the fee leg so
    // dust accrues to the protocol, not the trader. The fee USDC is a
    // separate transfer to the global `fee_pool_vault`; the
    // `sooth_launchpad::distribute_fees` crank does the 4-way split later.
    let cost_usdc: u64 = wad_to_usdc_ceil(cost_wad as u128).map_err(map_math_err)?;
    let fee_usdc: u64 = wad_to_usdc_ceil(fee_wad).map_err(map_math_err)?;

    // ── 6. Token transfers ───────────────────────────────────────────────
    //
    // Two transfers, both user-signed:
    //   1. `cost_usdc` → `market_vault` (collateral; backs YES/NO redemption)
    //   2. `fee_usdc`  → `fee_pool_vault` (drained by `distribute_fees`)
    //
    // Why two transfers (not one combined `cost+fee` to market_vault):
    //   - `market_vault` is the redemption-side vault; co-mingling fees
    //     with collateral would inflate the redeemable per-share value
    //     and require subtracting the fee balance at redemption time.
    //   - The `fee_pool_vault` authority is a `sooth_launchpad` PDA, and
    //     `sooth_launchpad::distribute_fees` signs against it directly
    //     without a second-program CPI hop — see the pool-then-distribute
    //     rationale in `distribute_fees.rs`'s docstring.
    //
    // Two `spl-token::transfer` CPIs cost ~10k CU together; the previous
    // ~68k CU envelope (architecture §5) gains ~5k from the new transfer
    // and ~1k from the ProtocolConfig parse. Fits comfortably under the
    // 200k default per-instruction limit.
    let cost_cpi = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.user_usdc_ata.to_account_info(),
            to: ctx.accounts.market_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    );
    token::transfer(cost_cpi, cost_usdc)?;
    ctx.accounts.position.locked_cost_usdc = ctx
        .accounts
        .position
        .locked_cost_usdc
        .checked_add(cost_usdc)
        .ok_or(error!(SoothAmmError::MathOverflow))?;

    if fee_usdc > 0 {
        let fee_cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc_ata.to_account_info(),
                to: ctx.accounts.fee_pool_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(fee_cpi, fee_usdc)?;
    }

    // Track the same fee in the per-market WAD accumulator after the SPL
    // fee-pool transfer succeeds. The global `fee_pool_vault` remains the
    // drainable token balance for `distribute_fees`; this field is the
    // market-scoped WAD ledger used by graduation checks and analytics.
    //
    // `fee_wad` is the WAD-scale fee already computed above from floor
    // division of the positive buy cost. Adding it directly keeps the
    // comparison shape aligned with the graduation threshold `b * ln(2)`,
    // which is also represented as u128 WAD.
    ctx.accounts.amm_state.fee_b_base_wad = ctx
        .accounts
        .amm_state
        .fee_b_base_wad
        .checked_add(fee_wad)
        .ok_or(error!(SoothAmmError::MathOverflow))?;

    {
        let amm = &mut ctx.accounts.amm_state;
        if !amm.is_graduated {
            let threshold_wad = wad_mul(amm.b, LN2_WAD)
                .map_err(map_math_err)?
                .try_into()
                .map_err(|_| error!(SoothAmmError::MathOverflow))?;
            if amm.fee_b_base_wad >= threshold_wad {
                amm.is_graduated = true;
                emit!(MarketGraduated {
                    market: amm.market,
                    fees_accumulated_wad: amm.fee_b_base_wad,
                    threshold_wad,
                });
            }
        }
    }

    // ── 7. State mutation (REAL) ─────────────────────────────────────────
    //
    // Scoped — the mutable borrows on `amm_state` / `position` must be
    // dropped before the LP-mint CPI below, which re-borrows `position`
    // via `to_account_info()`.
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

    // ── 8. LP mint on pre-graduation buys ────────────────────────────────
    //
    // Architecture §4.2: pre-graduation, every buy mints LP tokens to the
    // trader. EVM precedent (`FeeRouter._distributePreGrad` line 354 +
    // `AMMEngine.mintLPTokens` line 542): `1 LP unit ≡ 1 fee WAD`. We use
    // the USDC-base-unit equivalent (`fee_usdc`, ceil-converted from
    // `fee_wad` already on line ~355) because the LP mint has 6 decimals
    // matching USDC — so `fee_usdc` LP base units corresponds to the same
    // dollar-denominated fee. This also matches the convention in
    // `seed_lp` where `args.lp_amount = total_initial_b` (creator's seed
    // deposit in USDC base units).
    //
    // Post-graduation, no LP mint and the fee split kicks in instead
    // (the post-grad split is destination-side, applied later in
    // `sooth_launchpad::distribute_fees`).
    //
    // ## Cyclic-dep avoidance — manual CPI
    //
    // `sooth_amm` cannot take a path-dep on `sooth_launchpad` (the
    // launchpad already depends on the AMM via the `cpi` feature for
    // `create_market`'s composition CPI; the reverse direction would
    // close the cycle). We construct the `mint_lp_for_buy` ix manually:
    // 8-byte Anchor discriminator + Borsh-serialised `amount: u64`, and
    // dispatch via `solana_program::program::invoke`. The ix accepts no
    // signer seeds from the caller — its own handler PDA-signs against
    // `lp_mint_authority` (which is owned by `sooth_launchpad`).
    //
    // Account list ordering MUST match
    // `sooth_launchpad::instructions::mint_lp_for_buy::MintLpForBuy`:
    //   [market, lp_mint, lp_mint_authority, user_lp_ata, position,
    //    user, instruction_sysvar, token_program]
    if !amm_is_graduated && fee_usdc > 0 {
        let lp_amount: u64 = fee_usdc;

        let mint_lp_accounts = vec![
            AccountMeta::new_readonly(ctx.accounts.market.key(), false),
            AccountMeta::new(ctx.accounts.lp_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.lp_mint_authority.key(), false),
            AccountMeta::new(ctx.accounts.user_lp_ata.key(), false),
            AccountMeta::new_readonly(ctx.accounts.position.key(), false),
            AccountMeta::new_readonly(ctx.accounts.user.key(), true),
            AccountMeta::new_readonly(ctx.accounts.instruction_sysvar.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        ];

        let mut data = Vec::with_capacity(16);
        data.extend_from_slice(&MINT_LP_FOR_BUY_DISCRIMINATOR);
        data.extend_from_slice(&lp_amount.to_le_bytes());

        let ix = Instruction {
            program_id: SOOTH_LAUNCHPAD_PROGRAM_ID,
            accounts: mint_lp_accounts,
            data,
        };

        invoke(
            &ix,
            &[
                ctx.accounts.market.to_account_info(),
                ctx.accounts.lp_mint.to_account_info(),
                ctx.accounts.lp_mint_authority.to_account_info(),
                ctx.accounts.user_lp_ata.to_account_info(),
                ctx.accounts.position.to_account_info(),
                ctx.accounts.user.to_account_info(),
                ctx.accounts.instruction_sysvar.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.sooth_launchpad_program.to_account_info(),
            ],
        )?;
    }

    // ── 9. Emit (REAL) ───────────────────────────────────────────────────
    // `now` is the same `Clock::get()` snapshot used by the C1 trading-window
    // guard above — re-using avoids a second sysvar load (~100 CU) and keeps
    // the emitted timestamp consistent with the guard.
    emit!(PositionTraded {
        market: market_key,
        user: user_key,
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
