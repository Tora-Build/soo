//! `market_fee_pool` — seed constants for per-market fee-pool PDAs.
//!
//! The fee pool itself is a plain SPL `TokenAccount` (no custom struct).
//! These constants are the PDA seeds used when deriving the fee-pool authority
//! and per-market fee-pool token accounts.

/// Seed for the singleton fee-pool authority signer PDA.
/// Seeds: `[FEE_POOL_AUTHORITY_SEED]` under `sooth_core::ID`.
pub const FEE_POOL_AUTHORITY_SEED: &[u8] = b"fee_pool_authority";

/// Seed prefix for the per-market BOOK-venue fee pool.
/// Seeds: `[FEE_POOL_BOOK_SEED, market_id]` under `sooth_core::ID`.
///
/// One pool per venue, because an SPL token account holds exactly one mint and
/// the venues are denominated differently. Distinct seed literals rather than
/// one seed plus the mint: the venue is then fixed by the derivation itself,
/// so an instruction cannot be handed the other venue's pool.
pub const FEE_POOL_BOOK_SEED: &[u8] = b"fee_pool_book";

/// Seed prefix for the per-market AMM-venue fee pool.
/// Seeds: `[FEE_POOL_AMM_SEED, market_id]` under `sooth_core::ID`.
pub const FEE_POOL_AMM_SEED: &[u8] = b"fee_pool_amm";

/// Seed for the LP yield authority signer PDA.
/// Seeds: `[LP_YIELD_AUTHORITY_SEED]` under `sooth_core::ID`.
pub const LP_YIELD_AUTHORITY_SEED: &[u8] = b"lp_yield_authority";
