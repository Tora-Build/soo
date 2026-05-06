//! `Market` account — the canonical lifecycle + custody record for one
//! prediction market.
//!
//! Architecture §2.2 (per-market state).
//!
//! ## PDA seed conventions (this program is the source of truth)
//!
//! All seeds are derived from `market.market_id` (16-byte
//! `keccak256(question || creator || nonce)` truncation per architecture
//! §2.2) — never from `market.key()`. This is **load-bearing**: `sooth_amm`
//! already commits to `market.market_id.as_ref()` for its `Market` and
//! `AmmState` PDA seeds (see `sooth_amm/src/instructions/trade_positions.rs`),
//! and the cross-program PDA derivations must agree.
//!
//! | PDA / account     | Seeds                                  | Owner program |
//! |-------------------|----------------------------------------|---------------|
//! | `Market`          | `[b"market", market_id]`               | sooth_market  |
//! | `AmmState`        | `[b"amm",    market_id]`               | sooth_amm     |
//! | `yes_mint`        | `[b"mint",   market_id, b"y"]`         | spl-token     |
//! | `no_mint`         | `[b"mint",   market_id, b"n"]`         | spl-token     |
//! | `vault_authority` | `[b"vault",  market_id]`               | sooth_market  |
//! | `vault` (USDC)    | `get_associated_token_address(vault_authority, USDC)` | spl-associated-token |
//! | `lock_authority`  | `[b"lock",   market_id]`               | sooth_market  |
//! | `lock_vault` (USDC) | `get_associated_token_address(lock_authority, USDC)` | spl-associated-token |
//!
//! `vault_authority` and `lock_authority` are signer-only PDAs (no data, no
//! `#[account]`). The two USDC ATAs are created at `initialize_market` and
//! owned by their respective authority PDAs.
//!
//! ## SPL-Token vs Token-2022
//!
//! v1 uses classic SPL Token to match EVM ERC-20 semantics simply. Token-2022
//! is a deferred future upgrade; specifically the transfer-hook extension
//! could enforce post-settlement freeze on the losing-side mint (architecture
//! §10 footnote). Re-evaluate when Solana-wide ecosystem support for
//! Token-2022 is more uniform.
//!
//! ## EVM reference
//!
//! Mirrors `TruthMarket.sol`. The Solana account stores fields that EVM
//! encoded as immutable args (`questionHash`, `startTime`, `deadline`,
//! `adjudicator`, `creator`) plus the mutable lifecycle state.

use anchor_lang::prelude::*;

use super::lifecycle::MarketLifecycle;

#[account]
pub struct Market {
    /// Deterministic id derived from `keccak256(question || creator || nonce)`,
    /// truncated to 16 bytes per architecture §2.2. Seed for every per-market
    /// PDA in the protocol — see module comment.
    pub market_id: [u8; 16],

    pub creator: Pubkey,
    /// Adjudicator program id. The adjudicator-CPI auth check on `lock` /
    /// `settle` will validate the caller's program against this.
    pub adjudicator: Pubkey,
    pub question_hash: [u8; 32],

    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    /// USDC ATA owned by `vault_authority` PDA. All collateral for this market.
    pub vault: Pubkey,
    /// USDC ATA owned by `lock_authority` PDA. AMM lock-on-sell escrow.
    pub lock_vault: Pubkey,

    pub start_time: i64,
    pub deadline: i64,

    pub lifecycle: MarketLifecycle,
    /// Resolved outcome, valid only when `lifecycle == Settled`.
    /// 0 = NO, 1 = YES, 2 = INVALID per protocol-wide OUTCOME encoding.
    pub winning_outcome: u8,

    /// Bump for the `Market` PDA itself.
    pub bump: u8,
    /// Bump for the `vault_authority` signer PDA.
    pub vault_authority_bump: u8,
    /// Bump for the `lock_authority` signer PDA.
    pub lock_authority_bump: u8,
    /// Bump for `yes_mint` PDA.
    pub yes_mint_bump: u8,
    /// Bump for `no_mint` PDA.
    pub no_mint_bump: u8,
}

impl Market {
    /// Borsh-serialized size for rent calculation. Anchor's 8-byte
    /// discriminator is added by `#[account]`. Update if fields change.
    pub const SPACE: usize = 8     // discriminator
        + 16                       // market_id
        + 32                       // creator
        + 32                       // adjudicator
        + 32                       // question_hash
        + 32                       // yes_mint
        + 32                       // no_mint
        + 32                       // vault
        + 32                       // lock_vault
        + 8                        // start_time
        + 8                        // deadline
        + MarketLifecycle::SPACE   // lifecycle
        + 1                        // winning_outcome
        + 1 + 1 + 1 + 1 + 1;       // 5 bumps

    pub fn is_open(&self) -> bool {
        matches!(self.lifecycle, MarketLifecycle::Open)
    }

    pub fn is_settled(&self) -> bool {
        matches!(self.lifecycle, MarketLifecycle::Settled)
    }
}

/// Protocol-wide OUTCOME encoding. Mirrors `docs/glossary.md` and the constant
/// already in `sooth_amm` (duplicated here intentionally — until a shared
/// `sooth-protocol-types` crate exists, every program owns its own copy with a
/// pointer comment to the canonical glossary entry).
pub const OUTCOME_NO: u8 = 0;
pub const OUTCOME_YES: u8 = 1;
pub const OUTCOME_INVALID: u8 = 2;
