//! Error codes for `sooth_core`.
//!
//! Discriminants are ABI-stable — don't reorder once shipped.

use anchor_lang::prelude::*;

#[error_code]
pub enum SoothCoreError {
    // ── Market lifecycle ─────────────────────────────────────────────────────

    #[msg("Market is not in the Open lifecycle state")]
    MarketNotOpen,

    #[msg("Market is not Settled")]
    MarketNotSettled,

    #[msg("Lifecycle transition not permitted from current state")]
    InvalidLifecycleTransition,

    #[msg("Invalid outcome (must be NO=0, YES=1, or INVALID=2)")]
    InvalidOutcome,

    #[msg("Amount must be non-zero")]
    ZeroAmount,

    #[msg("Insufficient outcome-token balance")]
    InsufficientOutcomeShares,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Vault / mint authority mismatch")]
    VaultAuthorityMismatch,

    #[msg("Deadline must be greater than start_time")]
    InvalidDeadline,

    #[msg("Adjudicator pubkey must not be the default (all-zero) key")]
    AdjudicatorIsDefault,

    #[msg("Market is not dismissed")]
    MarketNotDismissed,

    #[msg("Trading window has closed (now >= deadline)")]
    TradingClosed,

    #[msg("Invalid tick")]
    InvalidTick,

    #[msg("Amount too small for base token decimals")]
    AmountTooSmallForBaseTokenDecimals,

    // ── AMM ──────────────────────────────────────────────────────────────────

    #[msg("Slippage: cost exceeded max_cost_wad")]
    SlippageExceeded,

    #[msg("delta_shares must be non-zero")]
    ZeroDelta,

    #[msg("Insufficient shares to sell")]
    InsufficientShares,

    #[msg("Market is dismissed")]
    MarketDismissed,

    #[msg("Liquidity parameter b must be > 0")]
    InvalidLiquidity,

    #[msg("Caller is not authorized for this action (creator mismatch)")]
    Unauthorized,

    #[msg("Trading window has not started yet (now < start_time)")]
    TradingNotStarted,

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

    // ── Market creation / LP ─────────────────────────────────────────────────

    #[msg("Fee bps must not exceed 10000 (100%)")]
    FeeBpsOutOfRange,

    #[msg("Fee split bps do not sum to 10000")]
    FeeSplitMismatch,

    #[msg("Treasury pubkey must be non-default")]
    InvalidTreasury,

    #[msg("Default trial period must be > 0")]
    InvalidTrialPeriod,

    #[msg("Fee pool is empty — nothing to distribute")]
    NothingToDistribute,

    #[msg("Market is not graduated")]
    NotGraduated,

    #[msg("LP amount must be > 0")]
    ZeroLpAmount,

    #[msg("LP supply is empty")]
    EmptyLpSupply,

    #[msg("Legacy fee drain already executed")]
    LegacyDrainAlreadyExecuted,

    // ── Adjudicator / resolution ─────────────────────────────────────────────

    #[msg("Caller is not the registered authority for this adjudicator")]
    NotAuthority,

    #[msg("Adjudicator has already attested an outcome; re-attestation is not permitted")]
    AlreadyAttested,

    #[msg("Adjudicator account does not match the supplied market")]
    AdjudicatorMarketMismatch,

    #[msg("Adjudicator has already been disputed; dispute is one-shot per market")]
    AlreadyDisputed,

    #[msg("Market is already settled; dispute can no longer override the outcome")]
    MarketAlreadySettled,

    // ── Orderbook (CLOB) ─────────────────────────────────────────────────────

    #[msg("Order id is outside the supported composite encoding range")]
    InvalidOrderId,

    #[msg("Decoded order id does not match the requested side or tick")]
    OrderIdSeedMismatch,

    #[msg("Book side is full for this tick")]
    BookSideFull,

    #[msg("Book side is not fully drained")]
    BookSideNotDrained,

    #[msg("Compaction drop count exceeds the per-call bound")]
    CompactBoundExceeded,

    #[msg("Market vault uses the wrong base mint")]
    WrongBaseMint,

    #[msg("MarketBook base mint does not match the market vault mint")]
    BaseMintDrift,

    #[msg("MarketBook accumulators must be reset before placing an order")]
    AccumulatorNotReset,

    #[msg("No cancellable order was found")]
    NoCancellableOrder,

    #[msg("Remaining-account bundle does not carry the crossing BookSide")]
    MissingCrossingBookSide,

    #[msg("Remaining-account bundle maker does not match the live order maker")]
    MakerAccountMismatch,

    #[msg("Remaining-account bundles must contain exactly three accounts per fill")]
    WrongBundleArity,

    // ── Protocol / circuit-breaker ───────────────────────────────────────────

    #[msg("Protocol is paused; trading, new liquidity and market creation are disabled")]
    ProtocolPaused,

    #[msg("Adjudicator has not yet attested an outcome for this market")]
    NotYetAttested,

    #[msg("Trading window has not closed yet (now < deadline)")]
    TradingNotClosed,
}
