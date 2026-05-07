//! `mint_lp_for_buy` — PDA-signed LP-token mint helper for the AMM buy path.
//!
//! Architecture §4.2: every pre-graduation buy mints additional LP units to
//! the trader, proportional to the fee paid. EVM analogue:
//! `FeeRouter._distributePreGrad` (`FeeRouter.sol:339-371`) which calls
//! `ammEngine.mintLPTokens(market, trader, fee)` — the `fee` argument is the
//! base-token WAD value, and the per-trader allocation is `1 LP unit ≡ 1 fee
//! WAD` (`AMMEngine.sol:534-545`).
//!
//! ## Why this lives in `sooth_launchpad`
//!
//! The `lp_mint_authority` PDA (seeds `[b"lp_mint_authority", market_id]`) is
//! derived under `sooth_launchpad::ID` — only this program can `invoke_signed`
//! against it. Same shape as the `vault_authority` / `lock_authority` cross-
//! program signing problem that Wave 4 resolved with `sooth_market`'s
//! `transfer_to_lock` helper. `sooth_amm::trade_positions` CPIs into THIS ix
//! on every pre-graduation buy; the helper PDA-signs the `spl_token::mint_to`
//! and credits the trader's LP ATA.
//!
//! ## Auth model
//!
//! Two layered gates, mirroring `sooth_market::transfer_to_lock`:
//!
//!   1. **User signature** — `user: Signer` re-checks the outer
//!      `trade_positions` signer flowed down through the CPI. Combined with
//!      the `position` constraint below this means the caller controls the
//!      Position the LP allocation is being credited against.
//!   2. **Parent-ix introspection** — the runtime's `Instructions` sysvar is
//!      walked to confirm one of the preceding top-level ixs is from
//!      `sooth_amm` with the `trade_positions` discriminator. This closes the
//!      hole where a user could call `mint_lp_for_buy` directly to mint LP
//!      units to their own ATA without producing a matching `Position`
//!      mutation. See `sooth_market::instruction_introspection` for the
//!      full mechanism — we reuse the same helper.
//!
//! ## Cyclic-dep avoidance
//!
//! `sooth_amm` cannot path-dep `sooth_launchpad` (the launchpad already
//! depends on `sooth_amm` for `create_market`'s composition CPI; the reverse
//! direction would close the cycle). `trade_positions` therefore constructs
//! the CPI manually via `solana_program::program::invoke` rather than using
//! Anchor's generated `cpi::` helper. The `MINT_LP_FOR_BUY_DISCRIMINATOR` is
//! pinned in `sooth_protocol_types::discriminators` for that call site.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

use sooth_market::instruction_introspection::require_parent_ix_from_program;
use sooth_protocol_types::{SOOTH_AMM_PROGRAM_ID, TRADE_POSITIONS_DISCRIMINATOR};

use crate::error::SoothLaunchpadError;

#[derive(Accounts)]
pub struct MintLpForBuy<'info> {
    /// Market PDA — owned by `sooth_market`. Read-only. Used to seed the
    /// `lp_mint` / `lp_mint_authority` PDA derivations and to bind the
    /// `position`'s market field.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Box<Account<'info, sooth_market::state::Market>>,

    /// LP token mint, mut for `mint_to`. Address pinned via PDA seeds (under
    /// `sooth_launchpad::ID`) so a forged mint can't be substituted.
    #[account(
        mut,
        seeds = [b"lp", market.market_id.as_ref()],
        bump,
    )]
    pub lp_mint: Box<Account<'info, Mint>>,

    /// Per-market signer-only PDA. The mint authority on `lp_mint`. Seeds
    /// `[b"lp_mint_authority", market_id]`. CHECK: derived via seeds; signs
    /// the `mint_to` CPI in the handler body.
    #[account(
        seeds = [b"lp_mint_authority", market.market_id.as_ref()],
        bump,
    )]
    pub lp_mint_authority: UncheckedAccount<'info>,

    /// User's LP-token ATA — destination of the `mint_to` CPI. Authority must
    /// be the `user`; mint must be `lp_mint`. The SDK pre-creates the ATA
    /// idempotently before dispatching `trade_positions`.
    #[account(
        mut,
        token::mint = lp_mint,
        token::authority = user,
    )]
    pub user_lp_ata: Box<Account<'info, TokenAccount>>,

    /// Per-(user, market) Position from `sooth_amm`. We can't type this as
    /// `Account<'info, sooth_amm::state::Position>` without a circular path-
    /// dep (sooth_launchpad already depends on sooth_amm via the `cpi`
    /// feature, but typing the Account would force re-verification of the
    /// account on read; the raw-byte parse here mirrors the
    /// `sooth_market::transfer_to_lock` pattern). The handler verifies
    /// owner + parses `user` from raw bytes.
    /// CHECK: hand-validated in handler.
    pub position: UncheckedAccount<'info>,

    /// User signature — the outer `trade_positions` ix requires a user
    /// signature; that flows down through the CPI.
    pub user: Signer<'info>,

    /// Instructions sysvar — read by the parent-ix introspection check.
    /// Address-pinned to the canonical sysvar pubkey so a malicious caller
    /// cannot substitute a forged sysvar with a fabricated instruction list.
    /// CHECK: address-pinned.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<MintLpForBuy>, amount: u64) -> Result<()> {
    // ── 0. Parent-ix introspection ───────────────────────────────────────
    //
    // Refuse any call whose top-level ix list does not include a
    // `sooth_amm::trade_positions` dispatch. The auth-gap closer: prevents
    // a direct `mint_lp_for_buy` call from minting LP units without the
    // matching on-chain trade.
    require_parent_ix_from_program(
        &ctx.accounts.instruction_sysvar,
        &SOOTH_AMM_PROGRAM_ID,
        &TRADE_POSITIONS_DISCRIMINATOR,
    )?;

    if amount == 0 {
        // No-op for zero — keeps the CPI surface tolerant of fee-rounding
        // edges where `fee_usdc == 0` (sub-base-unit fees floor to zero on
        // the `wad_to_usdc_ceil` step the AMM does upstream).
        return Ok(());
    }

    // ── 1. Position validation: owner + (user, market) PDA derivation ────
    //
    // The `Position` account must be (a) owned by `sooth_amm` and (b)
    // bound to the same `(user, market)` pair whose signature/derivation
    // gates this ix. Together with the `user_lp_ata.token::authority ==
    // user` check from the Accounts struct this means the LP allocation
    // lands in the trader's own ATA, not a third-party ATA.
    //
    // We CANNOT validate by parsing `position.user` from raw account data
    // here: when `trade_positions::init_if_needed` lazy-creates the
    // `Position` PDA on a user's first trade, the `position.user =
    // user_key` write goes to Anchor's in-memory `Box<Account>` cache. The
    // cache only flushes to the on-chain data slice on `Account::exit()`,
    // which Anchor runs at the end of the parent ix — AFTER this CPI. So
    // a raw `try_borrow_data()` read here would see `Pubkey::default()`
    // for the user field on every first-trade buy, breaking the gate.
    //
    // The PDA-derivation check is equivalent: the `Position` account at
    // `position.key()` must match `Pubkey::find_program_address([b"pos",
    // market_id, user.key()], &SOOTH_AMM_PROGRAM_ID)`. This is the same
    // seed scheme `sooth_amm::trade_positions` uses and binds the
    // `(user, market)` pair to the address without touching the data
    // slice. Owner check still gates a forged Position from a foreign
    // program.
    let position_ai = ctx.accounts.position.to_account_info();
    require_keys_eq!(
        *position_ai.owner,
        SOOTH_AMM_PROGRAM_ID,
        SoothLaunchpadError::Unauthorized
    );
    let market_id = ctx.accounts.market.market_id;
    let (expected_position, _bump) = Pubkey::find_program_address(
        &[b"pos", market_id.as_ref(), ctx.accounts.user.key().as_ref()],
        &SOOTH_AMM_PROGRAM_ID,
    );
    require_keys_eq!(
        position_ai.key(),
        expected_position,
        SoothLaunchpadError::Unauthorized
    );

    // ── 2. PDA-signed `mint_to` ──────────────────────────────────────────
    //
    // Authority = `lp_mint_authority` PDA, seeds `[b"lp_mint_authority",
    // market_id, &[bump]]`. EVM analogue: `LaunchpadLPToken.mint(trader,
    // amount)` from `_distributePreGrad` (`FeeRouter.sol:354`).
    let market_id = ctx.accounts.market.market_id;
    let lp_mint_authority_bump = ctx.bumps.lp_mint_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"lp_mint_authority",
        market_id.as_ref(),
        &[lp_mint_authority_bump],
    ]];

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.lp_mint.to_account_info(),
                to: ctx.accounts.user_lp_ata.to_account_info(),
                authority: ctx.accounts.lp_mint_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // No event — the parent `trade_positions` ix already emits
    // `PositionTraded` with the `cost_wad` that the LP-amount derives
    // from. An indexer pinned to `PositionTraded + (fee_bps from
    // ProtocolConfig)` reconstructs the LP delta deterministically.

    Ok(())
}
