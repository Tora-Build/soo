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
pub mod instruction_introspection;
pub mod instructions;
pub mod state;

pub use error::SoothMarketError;
pub use instructions::*;

// Placeholder program ID. Generate a real keypair before devnet deploy with:
//   `solana-keygen new --no-bip39-passphrase -o target/deploy/sooth_market-keypair.json`
// then update this and the matching entry in `Anchor.toml`. Mirrors the
// placeholder pattern in `sooth_amm::lib.rs`.
declare_id!("5jweuZk3hGpck2teNZv5KUAuYzVEGgFoj1cyu1jffhZH");

// `SOOTH_AMM_PROGRAM_ID`, `SOOTH_ADJUDICATOR_PROGRAM_ID`, and
// `USDC_MINT_DEVNET` previously lived as hand-pinned literals here. They
// now live in the workspace-shared `sooth_protocol_types` crate (sister to
// `sooth-account-offsets`); we re-export them at this path so existing
// call sites that reach for `crate::SOOTH_AMM_PROGRAM_ID` etc. keep
// resolving without a churn-pass on every `#[account(address = ...)]`
// or `owner = ...` constraint, and so external test crates that import
// `sooth_market::SOOTH_AMM_PROGRAM_ID` keep compiling.
//
// The compile-time assert below ties `crate::ID_CONST` (Anchor's
// address-of-truth from `declare_id!`) back to the shared constant so any
// drift between the two trips the build.
pub use sooth_protocol_types::{
    SOOTH_ADJUDICATOR_PROGRAM_ID, SOOTH_AMM_PROGRAM_ID, USDC_MINT_DEVNET,
};

/// Compile-time assert that `declare_id!` matches
/// `sooth_protocol_types::SOOTH_MARKET_PROGRAM_ID`. See the matching
/// assertion in `sooth_amm/src/lib.rs` for the full rationale.
const _: () = assert!(sooth_protocol_types::pubkey_eq(
    crate::ID_CONST,
    sooth_protocol_types::SOOTH_MARKET_PROGRAM_ID,
));

#[program]
pub mod sooth_market {
    use super::*;

    /// One-shot bootstrap of the singleton adjudicator allowlist PDA.
    /// Codex C2 minimum-viable mitigation — see
    /// `state/adjudicator_allowlist.rs`. MUST be called before any
    /// `initialize_market` ix; market creation now requires the allowlist
    /// PDA to exist.
    pub fn initialize_adjudicator_allowlist(
        ctx: Context<InitializeAdjudicatorAllowlist>,
        authority: Pubkey,
    ) -> Result<()> {
        instructions::initialize_adjudicator_allowlist::handler(ctx, authority)
    }

    /// Append a pubkey to the adjudicator allowlist (gated on
    /// `allowlist.authority`). See `instructions/add_adjudicator.rs`.
    pub fn add_adjudicator(ctx: Context<AddAdjudicator>, adjudicator: Pubkey) -> Result<()> {
        instructions::add_adjudicator::handler(ctx, adjudicator)
    }

    /// Remove a pubkey from the adjudicator allowlist (gated on
    /// `allowlist.authority`). See `instructions/remove_adjudicator.rs`.
    pub fn remove_adjudicator(ctx: Context<RemoveAdjudicator>, adjudicator: Pubkey) -> Result<()> {
        instructions::remove_adjudicator::handler(ctx, adjudicator)
    }

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

    /// Split-authority complete-set mint for CPI escrow flows — pull
    /// `amount` USDC from a payer and mint YES + NO into token accounts owned
    /// by a separate destination authority.
    pub fn mint_complete_set_to_program_owned(
        ctx: Context<MintCompleteSetToProgramOwned>,
        amount: u64,
    ) -> Result<()> {
        instructions::mint_complete_set_to_program_owned::handler(ctx, amount)
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
    /// Body branches on `market.winning_outcome` per the EVM
    /// `TruthMarket.getRedemptionValue` table (1.0 USDC for the winning side,
    /// 0.5 for both on INVALID).
    pub fn redeem(ctx: Context<Redeem>) -> Result<()> {
        instructions::redeem::handler(ctx)
    }

    /// Split-destination redemption for CPI escrow flows — burn requested
    /// YES/NO amounts from a burn authority and pay USDC to an arbitrary
    /// token account.
    pub fn redeem_from_program_owned(
        ctx: Context<RedeemFromProgramOwned>,
        amount_yes: u64,
        amount_no: u64,
    ) -> Result<()> {
        instructions::redeem_from_program_owned::handler(ctx, amount_yes, amount_no)
    }

    /// Refund an AMM Position on a dismissed market, then close the Position
    /// via `sooth_amm::close_dismissed_position`.
    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        instructions::claim_refund::handler(ctx)
    }

    /// PDA-signed transfer `vault → lock_vault`. Helper for
    /// `sooth_amm::sell_positions` — the AMM CPIs into this so the signing
    /// PDA (`vault_authority`) is owned by the correct program. See
    /// `instructions/transfer_to_lock.rs` for the auth model.
    pub fn transfer_to_lock(ctx: Context<TransferToLock>, amount: u64) -> Result<()> {
        instructions::transfer_to_lock::handler(ctx, amount)
    }

    /// PDA-signed transfer `lock_vault → recipient`. Helper for
    /// `sooth_amm::claim_unlocked` — same rationale as `transfer_to_lock`.
    /// See `instructions/transfer_from_lock_vault.rs` for the auth model.
    pub fn transfer_from_lock_vault(
        ctx: Context<TransferFromLockVault>,
        amount: u64,
    ) -> Result<()> {
        instructions::transfer_from_lock_vault::handler(ctx, amount)
    }
}
