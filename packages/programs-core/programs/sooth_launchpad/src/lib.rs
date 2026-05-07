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
//!   Architecture §1 row 7. Account stub-sized for the v1 surface.
//! - `LpMint` SPL Mint per market — mint authority = `protocol_config` PDA.
//!   Created by `seed_lp` in a future commit.
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
declare_id!("SoothLP111111111111111111111111111111111111");

/// Re-export of the canonical devnet USDC mint from `sooth_market`. We pull
/// the constant transitively rather than triplicating it — see the long-term
/// plan in `sooth_market::USDC_MINT_DEVNET`'s doc-comment for the
/// `sooth-protocol-types` crate that will eventually own this. Used by
/// `seed_lp` (when wired) to pin USDC-side ATAs in the LP-mint flow.
pub use sooth_market::USDC_MINT_DEVNET;

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

    /// Mint LP tokens for a creator's seed deposit on a pre-graduation market.
    /// EVM analogue: `LaunchpadEngine._mintLPTokens` (private, called from
    /// `createMarket`). On Solana the LP-mint step is hoisted to its own ix
    /// because the `LpMint` PDA needs `init` codegen which would push
    /// `create_market`'s `try_accounts` frame past the SBF 4 KB ceiling (same
    /// constraint that fragmented `sooth_market::initialize_market`). STUB —
    /// body is `todo!()`.
    pub fn seed_lp(ctx: Context<SeedLp>, args: SeedLpArgs) -> Result<()> {
        instructions::seed_lp::handler(ctx, args)
    }
}
