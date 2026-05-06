//! `sooth_market` — Market lifecycle + USDC custody + outcome-token mint/merge.
//!
//! Solana port of the EVM `TruthMarket` (lifecycle state machine) and the
//! custody/mint/merge half of `OrderEngine`. The matching half of OrderEngine
//! lives in `sooth_book`; this program owns:
//!   - `Market` PDA (lifecycle, outcome, configuration)
//!   - `vault` PDA-authority ATA (all USDC collateral for one market)
//!   - `yes_mint` / `no_mint` SPL mints (mint authority = market PDA)
//!   - `lock_vault` PDA-authority ATA (sells locked here for the AMM 24h cooldown;
//!     see architecture §4.3 and the `lock_vault` placement note in
//!     `state/market.rs`).
//!
//! Architecture references:
//!   - `packages/programs-core/docs/architecture.md` §1 (program layout — this
//!     program collapses EVM `OrderEngine` + `TruthMarket` per the rationale
//!     "EVM split was for upgradability; on Solana we get program upgrades
//!     natively").
//!   - §2.2 (per-market state — Market, Vault, YesMint/NoMint).
//!   - §4.1 (createMarket call chain).
//!   - §4.4 (multi-phase adjudicator settlement — `lock_for_resolution` /
//!     `settle` are the on-program endpoints; the adjudicator-CPI auth check
//!     is left as `todo!()` until `sooth_adjudicator` lands).
//!   - §4.5 (redemption — full handler stubbed).
//!
//! EVM references (file:line citations on individual handlers):
//!   - `sooth-alpha/packages/contracts-core/src/TruthMarket.sol` for lifecycle
//!     and `getRedemptionValue`.
//!   - `sooth-alpha/packages/contracts-core/src/OrderEngine.sol` for `_mint` /
//!     `_merge` / `settlePosition`.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

pub use error::SoothMarketError;
pub use instructions::*;

// Placeholder program ID. Generate a real keypair before devnet deploy with:
//   `solana-keygen new --no-bip39-passphrase -o target/deploy/sooth_market-keypair.json`
// then update this and the matching entry in `Anchor.toml`. Mirrors the
// placeholder pattern in `sooth_amm::lib.rs`.
declare_id!("SoothMkt11111111111111111111111111111111111");

#[program]
pub mod sooth_market {
    use super::*;

    /// Create the Market PDA, both outcome SPL mints, and the USDC vault ATA.
    /// Architecture §4.1; mirrors EVM `LaunchpadEngine.createMarket` (which
    /// deployed a TruthMarket clone) — on Solana we collapse the deploy step
    /// into native PDA initialization.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        args: InitializeMarketArgs,
    ) -> Result<()> {
        instructions::initialize_market::handler(ctx, args)
    }

    /// Second leg of the create-market flow — initializes both outcome SPL
    /// mints. Split from `initialize_market` and `initialize_market_vaults`
    /// so each ix's `try_accounts` codegen stays under the SBF 4 KB stack
    /// frame; see `instructions/initialize_market.rs` module comment.
    pub fn initialize_outcome_mints(ctx: Context<InitializeOutcomeMints>) -> Result<()> {
        instructions::initialize_outcome_mints::handler(ctx)
    }

    /// Third leg of the create-market flow — initializes the USDC vault +
    /// lock-vault ATAs, then flips the market lifecycle from `Initializing`
    /// → `Open`. Split per the rationale in `initialize_market.rs`.
    pub fn initialize_market_vaults(ctx: Context<InitializeMarketVaults>) -> Result<()> {
        instructions::initialize_market_vaults::handler(ctx)
    }

    /// Mint a "complete set" — pull `amount` USDC from user, mint `amount`
    /// YES + `amount` NO into the user's outcome ATAs. EVM analogue:
    /// `OrderEngine._mint` (`OrderEngine.sol:680-694`).
    pub fn mint_complete_set(ctx: Context<MintCompleteSet>, amount: u64) -> Result<()> {
        instructions::mint_complete_set::handler(ctx, amount)
    }

    /// Merge a complete set — burn `amount` YES + `amount` NO, return
    /// `amount` USDC to the user. EVM analogue: `OrderEngine._merge`
    /// (`OrderEngine.sol:696-712`).
    pub fn merge_complete_set(ctx: Context<MergeCompleteSet>, amount: u64) -> Result<()> {
        instructions::merge_complete_set::handler(ctx, amount)
    }

    /// Lock the market for resolution (LIVE → LOCKED). EVM analogue:
    /// `TruthMarket.resolve` (`TruthMarket.sol:90-106`).
    pub fn lock_for_resolution(ctx: Context<LockForResolution>) -> Result<()> {
        instructions::lock_for_resolution::handler(ctx)
    }

    /// Settle the market with the adjudicator's winning outcome
    /// (LOCKED → SETTLED). EVM analogue: `TruthMarket.attest` +
    /// `TruthMarket.settle` collapsed (`TruthMarket.sol:112-131`).
    pub fn settle(ctx: Context<Settle>, winning_outcome: u8) -> Result<()> {
        instructions::settle::handler(ctx, winning_outcome)
    }

    /// Redeem winning shares for USDC. EVM analogue:
    /// `OrderEngine.settlePosition` (`OrderEngine.sol:399-431`).
    /// **STUB** — body is `todo!()` until `sooth_adjudicator` is wired.
    pub fn redeem(ctx: Context<Redeem>) -> Result<()> {
        instructions::redeem::handler(ctx)
    }
}
