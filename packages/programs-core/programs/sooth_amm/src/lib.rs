//! `sooth_amm` — LMSR-based AMM for Sooth Protocol prediction markets.
//!
//! Owns the binary-outcome LMSR cost function, per-(user, market) position
//! state, and the lock-on-sell flow. Architecture reference:
//! `packages/programs-core/docs/architecture.md` §4.2 (buyYes), §4.3 (sell),
//! §5 (CU budget), §8 (fee router).
//!
//! ## Status
//!
//! Scaffold. The LMSR math (the load-bearing CU question, resolved by
//! decision D4) is wired in fully. State mutation, CPIs to `spl-token`, the
//! fee router split, LP mint, and lock-on-sell are marked with `todo!()` /
//! `unimplemented!()` so reviewers see the full intended shape. See the
//! per-handler comments for what's done vs not.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

pub use error::SoothAmmError;
pub use instructions::*;

// Placeholder program ID. Generate a real keypair before devnet deploy with:
//   `solana-keygen new --no-bip39-passphrase -o target/deploy/sooth_amm-keypair.json`
// then update this and the matching entry in `Anchor.toml`. The 32-byte
// base58 below decodes to a valid (non-curve) pubkey usable as a placeholder.
declare_id!("67zS8M81LATLxEgegm5jyYgwFYNTfbF3FnYqxjbZKp7k");

// `USDC_MINT_DEVNET` and `SOOTH_LAUNCHPAD_PROGRAM_ID` previously lived as
// hand-pinned literals here. They now live in the workspace-shared
// `sooth_protocol_types` crate (sister to `sooth-account-offsets`); we
// re-export them at this path so existing call sites that reach for
// `crate::USDC_MINT_DEVNET` / `crate::SOOTH_LAUNCHPAD_PROGRAM_ID` keep
// resolving without a churn-pass on every `#[account(address = ...)]`
// constraint. The compile-time assert below ties `crate::ID_CONST`
// (Anchor's address-of-truth from `declare_id!`) back to the shared
// constant so any drift between the two trips the build.
pub use sooth_protocol_types::{SOOTH_LAUNCHPAD_PROGRAM_ID, USDC_MINT_DEVNET};

/// Compile-time assert that `declare_id!` (Anchor's source of truth for
/// program ID, IDL emission, and dispatch) matches the value mirrored in
/// `sooth_protocol_types::SOOTH_AMM_PROGRAM_ID` (the constant other
/// programs pin in their `address = ...` / `owner = ...` / parent-ix
/// introspection paths). Drift trips the build.
const _: () = assert!(sooth_protocol_types::pubkey_eq(
    crate::ID_CONST,
    sooth_protocol_types::SOOTH_AMM_PROGRAM_ID,
));

/// Number of seconds AMM sell proceeds remain locked in the per-market
/// `lock_vault` before the user can `claim_unlocked`. Architecture §4.3.
///
/// EVM precedent: every production deploy config in
/// `sooth-alpha/packages/contracts-core/config/*.json` sets
/// `lockDurationSeconds = 86400`. The Solidity AMM (`AMMEngine.sol:48-49`)
/// bounds `_lockDuration` to `[30 minutes, 36 hours]`; we hard-code 24h here
/// because the Solana port doesn't expose a per-deploy admin key on the
/// AMM, and changing the constant requires a program upgrade anyway.
///
/// If a future deploy needs a different value, lift this into the
/// `AmmState` PDA at `initialize_amm_state` time and pin a similar
/// `[MIN, MAX]` validation range to mirror the EVM.
pub const LOCK_DURATION_SECS: i64 = 24 * 60 * 60;

#[program]
pub mod sooth_amm {
    use super::*;

    /// Initialize the per-market `AmmState` PDA. Must be called by the
    /// market creator after `sooth_market::initialize_market_vaults`. See
    /// `instructions/initialize_amm_state.rs`.
    pub fn initialize_amm_state(
        ctx: Context<InitializeAmmState>,
        args: InitializeAmmStateArgs,
    ) -> Result<()> {
        instructions::initialize_amm_state::handler(ctx, args)
    }

    /// Buy or sell YES/NO shares against the LMSR.
    ///
    /// `delta_shares > 0` is a buy; `delta_shares < 0` is a sell. The cost
    /// (signed in WAD) is `C(q + Δ) - C(q)` with `C(q_yes, q_no, b) = b · ln(
    /// exp(q_yes/b) + exp(q_no/b))`. See architecture §4.2 / §4.3.
    pub fn trade_positions(
        ctx: Context<TradePositions>,
        outcome: u8,
        delta_shares: i128,
        max_cost_wad: u128,
    ) -> Result<()> {
        instructions::trade_positions::handler(ctx, outcome, delta_shares, max_cost_wad)
    }

    /// Sell YES/NO shares against the LMSR. Mirrors `trade_positions` for
    /// the buy path, but moves proceeds USDC into a per-sell `LockEntry`
    /// PDA escrow with a 24h cooldown (`LOCK_DURATION_SECS`). The user
    /// later calls `claim_unlocked` to drain the escrow. Architecture §4.3.
    ///
    /// `delta_shares` MUST be negative (sell). `min_proceeds_wad = 0`
    /// disables the slippage check; otherwise the trade reverts if
    /// `|cost_wad| < min_proceeds_wad`.
    ///
    /// See the "Buy vs sell split" comment in `trade_positions.rs` for why
    /// this is a separate ix from `trade_positions`.
    pub fn sell_positions(
        ctx: Context<SellPositions>,
        outcome: u8,
        delta_shares: i128,
        min_proceeds_wad: u128,
    ) -> Result<()> {
        instructions::sell_positions::handler(ctx, outcome, delta_shares, min_proceeds_wad)
    }

    /// Claim USDC proceeds from a `LockEntry` whose 24h lock has elapsed.
    /// Closes the `LockEntry` account and refunds rent to the user.
    /// Architecture §4.3; mirrors EVM `AMMEngine.claimUnlocked`.
    pub fn claim_unlocked(ctx: Context<ClaimUnlocked>) -> Result<()> {
        instructions::claim_unlocked::handler(ctx)
    }

    /// Close an AMM Position after `sooth_market::claim_refund` has transferred
    /// the tracked locked cost back to the user. Rejects direct calls via
    /// parent-ix introspection.
    pub fn close_dismissed_position(ctx: Context<CloseDismissedPosition>) -> Result<()> {
        instructions::close_dismissed_position::handler(ctx)
    }

    pub fn dismiss_market(ctx: Context<DismissMarket>) -> Result<()> {
        instructions::dismiss_market::handler(ctx)
    }
}
