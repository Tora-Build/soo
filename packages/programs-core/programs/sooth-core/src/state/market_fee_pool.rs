//! `market_fee_pool` — seed constants for per-market fee-pool PDAs.
//!
//! The fee pool itself is a plain SPL `TokenAccount` (no custom struct).
//! These constants are the PDA seeds used when deriving the fee-pool authority
//! and per-market fee-pool token accounts.

/// Seed for the singleton fee-pool authority signer PDA.
/// Seeds: `[FEE_POOL_AUTHORITY_SEED]` under `sooth_core::ID`.
pub const FEE_POOL_AUTHORITY_SEED: &[u8] = b"fee_pool_authority";

/// Seed prefix for per-market fee-pool token accounts.
/// Seeds: `[MARKET_FEE_POOL_SEED, market_id]` under `sooth_core::ID`.
pub const MARKET_FEE_POOL_SEED: &[u8] = b"market_fee_pool";

/// Seed for the LP yield authority signer PDA.
/// Seeds: `[LP_YIELD_AUTHORITY_SEED]` under `sooth_core::ID`.
pub const LP_YIELD_AUTHORITY_SEED: &[u8] = b"lp_yield_authority";
