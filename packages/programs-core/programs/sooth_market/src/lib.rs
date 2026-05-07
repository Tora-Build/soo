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
declare_id!("SoothMkt11111111111111111111111111111111111");

/// Hard-coded `sooth_amm` program ID. Used by the `transfer_to_lock` /
/// `transfer_from_lock_vault` helpers to verify the `Position` / `LockEntry`
/// accounts they receive are owned by the legitimate AMM program (and not
/// forged Borsh blobs the caller stitched together). Mirrors the `declare_id!`
/// in `programs/sooth_amm/src/lib.rs` — bump both in lock-step on devnet
/// deploy. A workspace-shared `sooth-protocol-types` crate would be the
/// long-term home; until then, the duplication is intentional with a sync
/// comment in both directions.
pub const SOOTH_AMM_PROGRAM_ID: Pubkey = anchor_lang::pubkey!(
    "SoothAMM11111111111111111111111111111111111"
);

/// Canonical devnet USDC mint. Must match `sooth_amm::USDC_MINT_DEVNET` —
/// a workspace-shared crate (`sooth-protocol-types`) is the right long-term
/// home for this constant, but until that crate exists this is duplicated
/// here intentionally with a sync comment. Used by `initialize_market_vaults`,
/// `mint_complete_set`, `merge_complete_set`, and `redeem` to pin the
/// `usdc_mint` account against a forged/malicious mint passed by the caller.
/// Mainnet uses `EPjFW...`; the SDK swaps the constant per cluster at deploy.
pub const USDC_MINT_DEVNET: Pubkey = anchor_lang::pubkey!(
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);

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
    pub fn remove_adjudicator(
        ctx: Context<RemoveAdjudicator>,
        adjudicator: Pubkey,
    ) -> Result<()> {
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
