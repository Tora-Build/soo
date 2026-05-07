//! Byte-offset constants for `sooth_amm`-owned accounts that are read raw
//! by `sooth_market`'s `transfer_to_lock` / `transfer_from_lock_vault`
//! helpers.
//!
//! ## Why these live in a separate crate
//!
//! `sooth_amm` depends on `sooth_market` (via the `cpi` feature) for the
//! PDA-signed transfer helpers. Going the other way — typing
//! `Account<'info, sooth_amm::Position>` from inside `sooth_market` — would
//! introduce a cyclic Cargo dep. The helpers therefore parse `Position` and
//! `LockEntry` raw bytes via hand-validated offsets. Centralising those
//! offsets here keeps the two transfer helpers and the struct definitions
//! in `sooth_amm::state` provably synchronised: `sooth_amm` carries
//! `const _: () = assert!(...)` checks that compare these constants against
//! the live `SPACE` figures, so any future field change that drifts from
//! the constants below trips the build rather than producing silent
//! on-chain account-data corruption.
//!
//! ## Layout assumptions
//!
//! Anchor's `#[account]` macro derives Borsh serialisation, which writes
//! struct fields sequentially in declaration order with no padding and no
//! tag/length prefix. The 8-byte Anchor discriminator precedes the field
//! data. So byte offsets here are the cumulative sum of preceding field
//! sizes (with discriminator counted as the first 8 bytes).
//!
//! These constants describe the **on-chain account-data byte layout**, NOT
//! Rust's in-memory layout — `core::mem::offset_of!` would not return these
//! values for the corresponding `Position` / `LockEntry` structs because the
//! Anchor account types are not `#[repr(C)]`.

#![no_std]

// ── Position layout ──────────────────────────────────────────────────────
//
// Mirror of `sooth_amm::state::Position`:
//   #[account]
//   pub struct Position {
//       pub user: Pubkey,        // 32
//       pub market: Pubkey,      // 32
//       pub yes_shares: i128,    // 16
//       pub no_shares: i128,     // 16
//       pub lock_nonce: u64,     // 8
//       pub bump: u8,            // 1
//   }
// Total payload = 105 bytes; with the 8-byte discriminator that's 113.

/// Anchor account discriminator length (sha256("account:Position")[..8]).
pub const POSITION_DISCRIMINATOR_LEN: usize = 8;

/// Byte size of `Pubkey` payload field on `Position`.
pub const POSITION_USER_LEN: usize = 32;
pub const POSITION_MARKET_LEN: usize = 32;
pub const POSITION_YES_SHARES_LEN: usize = 16;
pub const POSITION_NO_SHARES_LEN: usize = 16;
pub const POSITION_LOCK_NONCE_LEN: usize = 8;
pub const POSITION_BUMP_LEN: usize = 1;

/// Offset (from start of account data) of `Position::user`.
pub const POSITION_USER_OFFSET: usize = POSITION_DISCRIMINATOR_LEN;
/// Offset of `Position::market`.
pub const POSITION_MARKET_OFFSET: usize = POSITION_USER_OFFSET + POSITION_USER_LEN;
/// Offset of `Position::yes_shares`.
pub const POSITION_YES_SHARES_OFFSET: usize = POSITION_MARKET_OFFSET + POSITION_MARKET_LEN;
/// Offset of `Position::no_shares`.
pub const POSITION_NO_SHARES_OFFSET: usize = POSITION_YES_SHARES_OFFSET + POSITION_YES_SHARES_LEN;
/// Offset of `Position::lock_nonce`.
pub const POSITION_LOCK_NONCE_OFFSET: usize = POSITION_NO_SHARES_OFFSET + POSITION_NO_SHARES_LEN;
/// Offset of `Position::bump`.
pub const POSITION_BUMP_OFFSET: usize = POSITION_LOCK_NONCE_OFFSET + POSITION_LOCK_NONCE_LEN;

/// Total on-chain size of a `Position` account (discriminator + payload).
/// Must equal `sooth_amm::state::Position::SPACE`. Asserted in `sooth_amm`.
pub const POSITION_TOTAL_LEN: usize = POSITION_BUMP_OFFSET + POSITION_BUMP_LEN;

// ── LockEntry layout ─────────────────────────────────────────────────────
//
// Mirror of `sooth_amm::state::LockEntry`:
//   #[account]
//   pub struct LockEntry {
//       pub user: Pubkey,        // 32
//       pub market: Pubkey,      // 32
//       pub amount_usdc: u64,    // 8
//       pub unlock_at: i64,      // 8
//       pub nonce: u64,          // 8
//       pub bump: u8,            // 1
//   }
// Total payload = 89 bytes; with the 8-byte discriminator that's 97.

pub const LOCK_ENTRY_DISCRIMINATOR_LEN: usize = 8;

pub const LOCK_ENTRY_USER_LEN: usize = 32;
pub const LOCK_ENTRY_MARKET_LEN: usize = 32;
pub const LOCK_ENTRY_AMOUNT_USDC_LEN: usize = 8;
pub const LOCK_ENTRY_UNLOCK_AT_LEN: usize = 8;
pub const LOCK_ENTRY_NONCE_LEN: usize = 8;
pub const LOCK_ENTRY_BUMP_LEN: usize = 1;

pub const LOCK_ENTRY_USER_OFFSET: usize = LOCK_ENTRY_DISCRIMINATOR_LEN;
pub const LOCK_ENTRY_MARKET_OFFSET: usize = LOCK_ENTRY_USER_OFFSET + LOCK_ENTRY_USER_LEN;
pub const LOCK_ENTRY_AMOUNT_USDC_OFFSET: usize =
    LOCK_ENTRY_MARKET_OFFSET + LOCK_ENTRY_MARKET_LEN;
pub const LOCK_ENTRY_UNLOCK_AT_OFFSET: usize =
    LOCK_ENTRY_AMOUNT_USDC_OFFSET + LOCK_ENTRY_AMOUNT_USDC_LEN;
pub const LOCK_ENTRY_NONCE_OFFSET: usize =
    LOCK_ENTRY_UNLOCK_AT_OFFSET + LOCK_ENTRY_UNLOCK_AT_LEN;
pub const LOCK_ENTRY_BUMP_OFFSET: usize = LOCK_ENTRY_NONCE_OFFSET + LOCK_ENTRY_NONCE_LEN;

/// Total on-chain size of a `LockEntry` account (discriminator + payload).
/// Must equal `sooth_amm::state::LockEntry::SPACE`. Asserted in `sooth_amm`.
pub const LOCK_ENTRY_TOTAL_LEN: usize = LOCK_ENTRY_BUMP_OFFSET + LOCK_ENTRY_BUMP_LEN;

// ── Internal sanity checks ───────────────────────────────────────────────
//
// These don't verify against the actual Position/LockEntry structs (this
// crate is no_std and intentionally pulls no anchor/borsh dep). They just
// pin the numerical values so a typo in one of the sums above can't
// silently change an offset. The cross-crate match against the Anchor
// SPACE constant lives in `sooth_amm/src/state/{position,lock_entry}.rs`.

const _: () = assert!(POSITION_USER_OFFSET == 8);
const _: () = assert!(POSITION_MARKET_OFFSET == 40);
const _: () = assert!(POSITION_YES_SHARES_OFFSET == 72);
const _: () = assert!(POSITION_NO_SHARES_OFFSET == 88);
const _: () = assert!(POSITION_LOCK_NONCE_OFFSET == 104);
const _: () = assert!(POSITION_BUMP_OFFSET == 112);
const _: () = assert!(POSITION_TOTAL_LEN == 113);

const _: () = assert!(LOCK_ENTRY_USER_OFFSET == 8);
const _: () = assert!(LOCK_ENTRY_MARKET_OFFSET == 40);
const _: () = assert!(LOCK_ENTRY_AMOUNT_USDC_OFFSET == 72);
const _: () = assert!(LOCK_ENTRY_UNLOCK_AT_OFFSET == 80);
const _: () = assert!(LOCK_ENTRY_NONCE_OFFSET == 88);
const _: () = assert!(LOCK_ENTRY_BUMP_OFFSET == 96);
const _: () = assert!(LOCK_ENTRY_TOTAL_LEN == 97);
