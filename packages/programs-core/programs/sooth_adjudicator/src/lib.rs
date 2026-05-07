//! `sooth_adjudicator` — per-market resolution authority + adjudicator framework.
//!
//! Solana port of EVM `AdjudicatorRegistry` + `IAdjudicator` interface +
//! the per-type adjudicator implementations (initially `ManualAdjudicator`).
//! Closes the deferred half of Codex's C2 finding: the abfcf15 allowlist
//! mitigation narrowed the *set* of valid adjudicator pubkeys at market
//! creation; this program lands the proper CPI-introspection auth path on
//! `sooth_market::lock_for_resolution` and `sooth_market::settle`.
//!
//! Architecture references:
//!   - `packages/programs-core/docs/architecture.md` §4.4 — multi-phase
//!     adjudicator (resolve → attest → settle, with veto branch on dispute).
//!   - `§7` — adjudicator framework on Solana, phased plan
//!     (Manual v1 → ZkTLS / Reclaim v2).
//!
//! EVM references:
//!   - `sooth-alpha/packages/contracts-core/src/AdjudicatorRegistry.sol`
//!     (the registry analogue — on Solana the "approved set" lives on
//!     `sooth_market::AdjudicatorAllowlist`; this program holds the per-
//!     market record + variant logic).
//!   - `sooth-alpha/packages/contracts-core/src/adjudicators/ManualAdjudicator.sol`
//!     (the v1 production variant).
//!   - `sooth-alpha/packages/contracts-core/src/adjudicators/AdjudicatorBase.sol`
//!     (configureMarket + outcome attest hooks).
//!
//! ## Defense-in-depth layering (post this program)
//!
//!   1. `sooth_market::AdjudicatorAllowlist` (commit abfcf15) constrains the
//!      *set* of pubkeys permitted to be named as `Market.adjudicator` at
//!      `initialize_market` time.
//!   2. `sooth_adjudicator::Adjudicator` PDA records the per-market authority
//!      + kind, registered post-create by `register_adjudicator`.
//!   3. `sooth_market::lock_for_resolution` / `settle` use parent-ix
//!      introspection to require the calling top-level ix is from
//!      `sooth_adjudicator::ID` with the matching discriminator. This is
//!      the auth-equivalent of EVM's `require(msg.sender == adjudicator())`.
//!
//! All three layers stay in place: the allowlist is the create-time gate,
//! the per-market PDA is the address-of-truth, and the introspection check
//! is the call-time gate. Removing any one of them widens the attack surface
//! in a documented, traceable way.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

pub use error::SoothAdjudicatorError;
pub use instructions::*;
pub use state::AdjudicatorKind;

// Placeholder program ID. Generate a real keypair before devnet deploy with:
//   `solana-keygen new --no-bip39-passphrase -o target/deploy/sooth_adjudicator-keypair.json`
// then update this and the matching entry in `Anchor.toml`. The 32-byte
// base58 below decodes to a valid (non-curve) pubkey usable as a placeholder
// — same convention as `sooth_amm`, `sooth_market`, and `sooth_launchpad`.
declare_id!("SoothAdj11111111111111111111111111111111111");

/// Compile-time assert that `declare_id!` matches
/// `sooth_protocol_types::SOOTH_ADJUDICATOR_PROGRAM_ID`. The shared
/// constant is what `sooth_market::lock_for_resolution` / `settle` pin in
/// their parent-ix introspection check; drift between the two sides would
/// fail closed (every adjudicator-CPI would be rejected as
/// `InvalidParentInstruction`), but the assert here surfaces the bug at
/// build time instead. See the matching assertion in `sooth_amm/src/lib.rs`
/// for the full rationale.
const _: () = assert!(sooth_protocol_types::pubkey_eq(
    crate::ID_CONST,
    sooth_protocol_types::SOOTH_ADJUDICATOR_PROGRAM_ID,
));

#[program]
pub mod sooth_adjudicator {
    use super::*;

    /// Create the per-market `Adjudicator` PDA recording the variant + the
    /// authority gate. v1 accepts the market.creator as registrar (collapsed
    /// role; production would gate on the protocol multisig). See
    /// `instructions/register_adjudicator.rs` for the full auth model.
    pub fn register_adjudicator(
        ctx: Context<RegisterAdjudicator>,
        authority: Pubkey,
        kind: AdjudicatorKind,
    ) -> Result<()> {
        instructions::register_adjudicator::handler(ctx, authority, kind)
    }

    /// Adjudicator-side trigger for `Open → Locked`. CPIs into
    /// `sooth_market::lock_for_resolution`, which gates on parent-ix
    /// introspection (caller must be this program). EVM analogue:
    /// `TruthMarket.resolve` invocation gated on
    /// `msg.sender == adjudicator()`.
    pub fn request_lock(ctx: Context<RequestLock>) -> Result<()> {
        instructions::request_lock::handler(ctx)
    }

    /// Manual variant: authority signs to attest the resolved outcome.
    /// Mutates Adjudicator state, then CPIs into `sooth_market::settle` to
    /// drive `Locked → Settled`. EVM analogue: `TruthMarket.attest` +
    /// `TruthMarket.settle` collapsed (ManualAdjudicator's `onlyOwner`
    /// equivalent on Solana is `adjudicator.authority` signature check).
    pub fn attest_outcome(ctx: Context<AttestOutcome>, winning_outcome: u8) -> Result<()> {
        instructions::attest_outcome::handler(ctx, winning_outcome)
    }

    /// Dispute / veto path. **STUB** — body returns
    /// `DisputeNotImplemented`. Architecture §4.4 sketches the veto branch;
    /// re-entering it post-v1 is a separate ix that does not require state-
    /// machine changes on the v1 surface.
    pub fn dispute(ctx: Context<Dispute>) -> Result<()> {
        instructions::dispute::handler(ctx)
    }
}
