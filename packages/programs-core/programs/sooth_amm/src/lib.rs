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
declare_id!("SoothAMM11111111111111111111111111111111111");

/// Canonical devnet USDC mint, used to pin the `usdc_mint` account on every
/// instruction that touches the market vault. Mainnet uses `EPjFW...`; the
/// SDK swaps the constant per cluster at deploy time.
///
/// TODO: replace with a workspace-shared constant once a `sooth-protocol-types`
/// crate exists. Both `sooth_amm` and `sooth_market` will pin the same value.
pub const USDC_MINT_DEVNET: Pubkey = anchor_lang::pubkey!(
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);

#[program]
pub mod sooth_amm {
    use super::*;

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
}
