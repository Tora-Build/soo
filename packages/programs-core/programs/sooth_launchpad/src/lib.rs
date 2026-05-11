//! `sooth_launchpad` — market factory, inlined fee router, and LP-mint owner.
//!
//! Solana port of EVM `LaunchpadEngine` (`sooth-alpha/packages/contracts-core/
//! src/LaunchpadEngine.sol`) plus the fee-distribution module from
//! `FeeRouter.sol`. Architecture decision §1 / §8: the EVM split exists for
//! upgrade granularity (FeeRouter is a separate contract behind a proxy); on
//! Solana we get program upgrades natively, so the fee-router math is **inlined
//! inside this program** — there is no `sooth_fee_router` crate. CPIs add CU
//! overhead with no architectural benefit.
//!
//! ## Status
//!
//! Scaffold. One ix is real (`initialize_protocol`); the remaining three are
//! `todo!()` stubs with finalized Accounts structs and signatures so the SDK
//! can pin its IDL shape early. See per-handler comments for the exact spec
//! pointer.
//!
//! ## What this program owns
//!
//! - `ProtocolConfig` PDA — singleton — `[b"protocol_config"]`. Fee bps,
//!   treasury pubkey, default trial period. Architecture §2.1.
//! - `LpPosition` PDA per (creator, market) — pre-graduation LP token claim.
//!   Architecture §1 row 7. Created by `seed_lp` (Wave 5C) alongside the
//!   per-market `LpMint`; bookkeeping for the dismiss/refund flow.
//! - `LpMint` SPL Mint per market — mint authority = `lp_mint_authority`
//!   PDA (per-market, seeds `[b"lp_mint_authority", market_id]`).
//!   Bootstrap-seeded by `seed_lp`; pre-graduation LP-mint-on-buy is a
//!   separate `sooth_amm::trade_positions` follow-up (architecture §4.2).
//!
//! ## What this program **wraps** via CPI
//!
//! `create_market` is the user-facing entry-point for market creation. It
//! composes the four-leg init flow from `sooth_market` and `sooth_amm` into
//! a single ix that lands in one transaction:
//!
//! 1. `sooth_market::initialize_market`         (lifecycle = Initializing)
//! 2. `sooth_market::initialize_outcome_mints`  (lifecycle = Initializing)
//! 3. `sooth_market::initialize_market_vaults`  (lifecycle → Open)
//! 4. `sooth_amm::initialize_amm_state`         (Open + AmmState ready)
//!
//! Architecture §4.1 enumerates each leg's args + lifecycle effect. The CPI
//! body is left as `todo!()` in this commit — it is intentionally non-trivial
//! (Solana's 4-deep CPI cap, account-list flattening, the `signer_seeds` for
//! the `vault_authority` / `lock_authority` PDAs that need to be re-asserted
//! across the boundary) and lands in a follow-up.
//!
//! EVM analogue: `LaunchpadEngine.createMarket` (`LaunchpadEngine.sol:204-339`).

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

pub use error::SoothLaunchpadError;
pub use instructions::*;

// Placeholder program ID. Generate a real keypair before devnet deploy with:
//   `solana-keygen new --no-bip39-passphrase -o target/deploy/sooth_launchpad-keypair.json`
// then update this and the matching entry in `Anchor.toml`. The 32-byte
// base58 below decodes to a valid (non-curve) pubkey usable as a placeholder
// — same convention as `sooth_amm` and `sooth_market`. Keypair has already
// been generated at `target/deploy/sooth_launchpad-keypair.json` (gitignored)
// for the eventual deploy; the placeholder ID stays in `declare_id!` until
// then so the IDL-shape is stable across the workspace.
declare_id!("8pHPMF1U86iDQTB5ig1xyjbcDMfS1PXi8LLD4EiqNqm8");

// `USDC_MINT_DEVNET` was previously re-exported from `sooth_market` to
// avoid triplicating the constant. It now lives in the workspace-shared
// `sooth_protocol_types` crate; we re-export it at this path so existing
// `crate::USDC_MINT_DEVNET` call sites (and `sooth_market::USDC_MINT_DEVNET`
// references in this crate's instructions module) keep resolving without
// a churn-pass. Used by `seed_lp` / `distribute_fees` / `create_market`
// to pin USDC-side ATAs.
pub use sooth_protocol_types::USDC_MINT_DEVNET;

/// Compile-time assert that `declare_id!` matches
/// `sooth_protocol_types::SOOTH_LAUNCHPAD_PROGRAM_ID`. See the matching
/// assertion in `sooth_amm/src/lib.rs` for the full rationale.
const _: () = assert!(sooth_protocol_types::pubkey_eq(
    crate::ID_CONST,
    sooth_protocol_types::SOOTH_LAUNCHPAD_PROGRAM_ID,
));

#[program]
pub mod sooth_launchpad {
    use super::*;

    /// Initialize the global `ProtocolConfig` PDA. **Single-shot**: must be
    /// called exactly once per cluster deploy by the protocol authority. Seeds
    /// `[b"protocol_config"]`. The `signer` becomes `config.authority` and is
    /// the only key that can rotate fee bps / treasury later (those setters
    /// are out-of-scope for this scaffold; see the comment in
    /// `instructions/initialize_protocol.rs`).
    ///
    /// EVM analogue: `LaunchpadEngine` constructor + `setDefaultTrialPeriod`
    /// / `setInvalidationBuffer` setters collapsed.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        args: InitializeProtocolArgs,
    ) -> Result<()> {
        instructions::initialize_protocol::handler(ctx, args)
    }

    /// Bootstrap the singleton global `fee_pool_vault` USDC ATA. **Single-
    /// shot**: must be called exactly once per cluster deploy. The ATA is
    /// owned by the `fee_pool_authority` PDA (seeds `[b"fee_pool_authority"]`)
    /// and consumed by `sooth_amm::trade_positions` /
    /// `sooth_amm::sell_positions` (push side) and
    /// `sooth_launchpad::distribute_fees` (drain side). Rent paid by `signer`;
    /// no authority gate — same convention as the other one-shot bootstraps.
    pub fn initialize_fee_pool(ctx: Context<InitializeFeePool>) -> Result<()> {
        instructions::initialize_fee_pool::handler(ctx)
    }

    /// Permissionless per-market fee-pool token account init. Creates the
    /// SPL TokenAccount PDA `[b"market_fee_pool", market.market_id]` with
    /// owner = `fee_pool_authority`.
    pub fn init_market_fee_pool(ctx: Context<InitMarketFeePool>) -> Result<()> {
        instructions::init_market_fee_pool::handler(ctx)
    }

    /// Create a tradeable market in one transaction by composing the four
    /// init legs from `sooth_market` + `sooth_amm` via CPI. STUB — body is
    /// `todo!()` until the CPI plumbing lands. Architecture §4.1 has the
    /// full call chain; the Accounts struct below already mirrors the union
    /// of the four leg's account lists so the IDL-shape is committed.
    pub fn create_market(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
        instructions::create_market::handler(ctx, args)
    }

    /// Drain the fee accumulator on `AmmState` and split the proceeds across
    /// the four destinations (bBase, LP yield, adjudicator, protocol treasury)
    /// per architecture §8. STUB — body is `todo!()`. The split bps are read
    /// from `ProtocolConfig`; the accumulator is read from `AmmState.fee_b_base_wad`
    /// (which `trade_positions` mutates today).
    pub fn distribute_fees(ctx: Context<DistributeFees>) -> Result<()> {
        instructions::distribute_fees::handler(ctx)
    }

    /// Mint LP tokens for a creator's seed deposit on a pre-graduation
    /// market. EVM analogue: `LaunchpadEngine._mintLPTokens` (private,
    /// called from `createMarket`). On Solana the LP-mint step is hoisted
    /// to its own ix because the `LpMint` PDA needs `init` codegen which
    /// would push `create_market`'s `try_accounts` frame past the SBF
    /// 4 KB ceiling (same constraint that fragmented
    /// `sooth_market::initialize_market`). REAL handler (Wave 5C) — see
    /// `instructions/seed_lp.rs` module comment for the hand-rolled
    /// `system_instruction::create_account` + `token::initialize_mint`
    /// + ATA-create + PDA-signed `mint_to` flow. Pre-graduation
    /// LP-mint-on-buy (architecture §4.2) is wired via `mint_lp_for_buy`
    /// below.
    pub fn seed_lp(ctx: Context<SeedLp>, args: SeedLpArgs) -> Result<()> {
        instructions::seed_lp::handler(ctx, args)
    }

    /// PDA-signed LP-token mint helper for the AMM buy path. CPI'd into by
    /// `sooth_amm::trade_positions` on every pre-graduation buy to credit
    /// the trader's LP ATA with `amount` LP base units (1:1 with the
    /// `fee_usdc` paid on the trade — mirrors EVM
    /// `FeeRouter._distributePreGrad` + `AMMEngine.mintLPTokens`).
    /// Auth: parent-ix introspection requires the calling top-level ix be
    /// a `sooth_amm::trade_positions` dispatch; user signature flows down
    /// through the CPI; the `Position` is parsed raw and matched against
    /// the user. See `instructions/mint_lp_for_buy.rs` module comment for
    /// the cross-program signing rationale (mirrors Wave 4's
    /// `sooth_market::transfer_to_lock` pattern).
    pub fn mint_lp_for_buy(ctx: Context<MintLpForBuy>, amount: u64) -> Result<()> {
        instructions::mint_lp_for_buy::handler(ctx, amount)
    }

    /// Burn post-graduation LP tokens and pay the holder a pro-rata share of
    /// the USDC yield vault based on the pre-burn LP mint supply.
    pub fn redeem_lp(ctx: Context<RedeemLp>, lp_amount: u64) -> Result<()> {
        instructions::redeem_lp::handler(ctx, lp_amount)
    }
}
