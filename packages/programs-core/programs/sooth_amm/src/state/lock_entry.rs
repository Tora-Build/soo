//! `LockEntry` account — proceeds-locked-on-sell record. Architecture §4.3.
//!
//! ## Seed scheme
//!
//! Each AMM sell creates a fresh `LockEntry` PDA at
//! `[b"lock_entry", position.key(), nonce.to_le_bytes()]`, where `nonce` is
//! the per-`Position` monotonic counter `Position::lock_nonce` at the moment
//! of the sell. The handler increments `position.lock_nonce` after init so
//! the next sell uses a fresh PDA.
//!
//! Two alternatives were considered:
//!
//!   1. `[b"lock", market_id, user, nonce]` — the layout sketched in
//!      `architecture.md §2`. Rejected because the `b"lock"` prefix already
//!      names the `lock_authority` PDA (`[b"lock", market_id]`) on
//!      `sooth_market`. PDAs with different seed counts can't collide
//!      mathematically, but reusing the prefix muddies the seed namespace
//!      and makes audit grep'ing fragile.
//!   2. `[b"lock_entry", market_id, user, nonce]` — namespace-clean, but
//!      requires the user to track a per-`(user, market)` counter
//!      out-of-band. Position already exists per-(user, market); reusing
//!      its address as a seed is shorter (32 bytes) and binds the lock
//!      lifecycle to the position lifecycle for free.
//!
//! Chosen scheme `[b"lock_entry", position.key(), nonce]` keeps seed
//! derivation cheap (no double-hash of `market_id || user`), distinct from
//! `lock_authority`, and gives Anchor a natural address to derive against
//! the per-(user, market) `Position` PDA.
//!
//! ## Lifecycle
//!
//! Created (`init`) by `trade_positions` on the sell branch; closed (`close
//! = user`) by `claim_unlocked` once `Clock::unix_timestamp >= unlock_at`.
//! Rent is refunded to the user on close. There is no admin path that can
//! touch the lock vault; if the user never claims, the rent stays locked
//! forever — same UX shape as the EVM contract's `_lockQueue`.

use anchor_lang::prelude::*;

#[account]
pub struct LockEntry {
    pub user: Pubkey,
    pub market: Pubkey,

    /// USDC base units (6 decimals on Solana mainnet) escrowed at sell time.
    pub amount_usdc: u64,

    /// Unix timestamp at which `claim_unlocked` becomes callable.
    pub unlock_at: i64,

    /// Per-`Position` monotonic nonce — part of the seed so multiple
    /// sells in flight don't collide on the same PDA. Mirrors the
    /// `Position::lock_nonce` value at sell time.
    pub nonce: u64,

    pub bump: u8,
}

impl LockEntry {
    pub const SPACE: usize = 8   // discriminator
        + 32                     // user
        + 32                     // market
        + 8                      // amount_usdc
        + 8                      // unlock_at
        + 8                      // nonce
        + 1;                     // bump
}
