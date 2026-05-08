//! `Position` account — per-(user, market). Architecture §2.3.
//!
//! Created lazily on the user's first trade via `init_if_needed` in
//! `trade_positions`. Rent (~0.002 SOL) is paid by the user; refundable on
//! `close_position` once both sides are zero (TODO instruction).

use anchor_lang::prelude::*;

#[account]
pub struct Position {
    pub user: Pubkey,
    pub market: Pubkey,

    /// Outstanding YES shares the user holds, WAD. Always ≥ 0.
    pub yes_shares: i128,
    /// Outstanding NO shares the user holds, WAD. Always ≥ 0.
    pub no_shares: i128,

    /// Sum-invariant: market_vault.amount == sum(Position.locked_cost_usdc) across all open
    /// positions for this market. Path-dependent: set on buy, saturating-decremented on sell.
    /// BREAKING layout change (SPACE 113 -> 121). Existing devnet/mainnet PDAs require migration;
    /// safe on fresh validator (cargo test / dev:localnet / dev:surfpool always boot fresh).
    pub locked_cost_usdc: u64,

    /// Per-`Position` monotonic counter incremented on every sell. Used as
    /// part of the `LockEntry` PDA seed so concurrent in-flight sells from
    /// the same user on the same market produce distinct lock accounts. See
    /// `state/lock_entry.rs` for the seed scheme rationale.
    ///
    /// Sized as `u64` to overflow-proof any plausible per-user trade count;
    /// at one sell per second this would last ~584 billion years.
    pub lock_nonce: u64,

    pub bump: u8,
}

impl Position {
    pub const SPACE: usize = 8   // discriminator
        + 32                     // user
        + 32                     // market
        + 16 + 16                // yes_shares, no_shares
        + 8                      // locked_cost_usdc
        + 8                      // lock_nonce
        + 1; // bump
}

// ── Cross-crate layout sync ──────────────────────────────────────────────
//
// `sooth_market`'s `transfer_to_lock` helper parses `Position` raw from
// account data via the byte offsets in `sooth-account-offsets`. The
// constants there are duplicated against the field layout above because
// Cargo's cyclic-dep ban (sooth_market would need sooth_amm to type the
// account directly) prevents a cleaner solution. These assertions tie the
// two ends together: any future change to the `Position` field list that
// alters the byte layout is forced to update `sooth-account-offsets` too,
// or the build fails.
//
// `Position` is `#[account]` — Borsh serialised, no `#[repr(C)]` — so
// `core::mem::offset_of!` returns Rust's in-memory offsets, not the
// on-chain byte offsets. Borsh writes fields in declaration order with no
// padding, so we instead pin the cumulative on-chain SPACE against the
// shared crate's `POSITION_TOTAL_LEN` (which is itself a sum of per-field
// lengths whose offsets are the actual targets the helper indexes into).
const _: () = assert!(
    Position::SPACE == sooth_account_offsets::POSITION_TOTAL_LEN,
    "Position::SPACE drifted from sooth-account-offsets::POSITION_TOTAL_LEN — \
     update both, including the per-field offsets in sooth-account-offsets/src/lib.rs"
);
