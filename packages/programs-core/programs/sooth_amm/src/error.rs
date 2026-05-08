//! Error codes for `sooth_amm`.
//!
//! Discriminants are ordered by likelihood-of-occurrence so the most common
//! errors get short instruction-data encodings. Don't reorder once we ship.

use anchor_lang::prelude::*;

#[error_code]
pub enum SoothAmmError {
    #[msg("Slippage: cost exceeded max_cost_wad")]
    SlippageExceeded,

    #[msg("Invalid outcome (must be NO=0 or YES=1)")]
    InvalidOutcome,

    #[msg("delta_shares must be non-zero")]
    ZeroDelta,

    #[msg("Insufficient shares to sell")]
    InsufficientShares,

    #[msg("Market is not in the Open lifecycle state")]
    MarketNotOpen,

    #[msg("Market is dismissed")]
    MarketDismissed,

    #[msg("LMSR math overflow or domain error")]
    MathOverflow,

    #[msg("Liquidity parameter b must be > 0")]
    InvalidLiquidity,

    #[msg("Caller is not authorized for this action (creator mismatch)")]
    Unauthorized,

    #[msg("Trading window has not started yet (now < start_time)")]
    TradingNotStarted,

    #[msg("Trading window has closed (now >= deadline)")]
    TradingClosed,

    #[msg("Sell path is not implemented yet — see trade_positions.rs §6 / architecture §4.3")]
    SellNotImplemented,

    #[msg("Lock has not elapsed yet (now < lock_entry.unlock_at)")]
    LockNotElapsed,

    #[msg("Lock vault account does not match market.lock_vault")]
    LockVaultMismatch,

    #[msg("Trial period has not expired yet")]
    TrialNotExpired,

    #[msg("Market has already graduated")]
    AlreadyGraduated,

    #[msg("Market has already been dismissed")]
    AlreadyDismissed,

    #[msg("AmmState market backlink does not match market account")]
    AmmStateMarketMismatch,

    #[msg("Market is not dismissed")]
    MarketNotDismissed,

    #[msg("Helper ix must be CPI'd from sooth_market::claim_refund")]
    InvalidParentInstruction,
}
