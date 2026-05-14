//! Merged error codes for `sooth_core`.
//!
//! All error variants from sooth_market, sooth_amm, sooth_launchpad,
//! sooth_adjudicator, and sooth_book are unified here.  Discriminants
//! are ordered by origin program, then by likelihood-of-occurrence.
//! Don't reorder once we ship.

use anchor_lang::prelude::*;

#[error_code]
pub enum SoothCoreError {
    // ── sooth_market ─────────────────────────────────────────────────────────

    #[msg("Market is not in the Open lifecycle state")]
    MarketNotOpen,

    #[msg("Market is not in the Locked lifecycle state")]
    MarketNotLocked,

    #[msg("Market is not Settled")]
    MarketNotSettled,

    #[msg("Lifecycle transition not permitted from current state")]
    InvalidLifecycleTransition,

    #[msg("Caller is not the registered adjudicator for this market")]
    NotAdjudicator,

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

    #[msg("Adjudicator pubkey is not present on the on-chain allowlist")]
    AdjudicatorNotAllowlisted,

    #[msg("Caller is not the registered allowlist authority")]
    AllowlistAuthorityMismatch,

    #[msg("Adjudicator allowlist is full (capacity exhausted)")]
    AllowlistFull,

    #[msg("Adjudicator pubkey is already present on the allowlist")]
    AdjudicatorAlreadyAllowlisted,

    #[msg("Adjudicator pubkey is not present on the allowlist")]
    AdjudicatorNotPresent,

    #[msg("Helper ixs must be CPI'd from sooth_amm; direct calls are rejected.")]
    InvalidParentInstruction,

    #[msg("Market is not dismissed")]
    MarketNotDismissed,

    #[msg("Invalid instructions sysvar account")]
    InvalidSysvar,

    #[msg("Trading window has closed (now >= deadline)")]
    TradingClosed,

    #[msg("Invalid tick")]
    InvalidTick,

    #[msg("Amount too small for base token decimals")]
    AmountTooSmallForBaseTokenDecimals,

    // ── sooth_amm ────────────────────────────────────────────────────────────

    #[msg("Slippage: cost exceeded max_cost_wad")]
    SlippageExceeded,

    #[msg("delta_shares must be non-zero")]
    ZeroDelta,

    #[msg("Insufficient shares to sell")]
    InsufficientShares,

    #[msg("Market is dismissed")]
    MarketDismissed,

    #[msg("LMSR math overflow or domain error")]
    LmsrOverflow,

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

    // ── sooth_launchpad ───────────────────────────────────────────────────────

    #[msg("Fee bps must not exceed 10000 (100%)")]
    FeeBpsOutOfRange,

    #[msg("Fee split bps do not sum to 10000")]
    FeeSplitMismatch,

    #[msg("Treasury pubkey must be non-default")]
    InvalidTreasury,

    #[msg("Default trial period must be > 0")]
    InvalidTrialPeriod,

    #[msg("Protocol config already initialized")]
    AlreadyInitialized,

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

    // ── sooth_adjudicator ─────────────────────────────────────────────────────

    #[msg("Caller is not the registered authority for this adjudicator")]
    NotAuthority,

    #[msg("Adjudicator kind does not support this operation")]
    UnsupportedKind,

    #[msg("Adjudicator has already attested an outcome; re-attestation is not permitted")]
    AlreadyAttested,

    #[msg("Adjudicator has not yet attested an outcome")]
    NotAttested,

    #[msg("Adjudicator account does not match the supplied market")]
    AdjudicatorMarketMismatch,

    #[msg("Authority pubkey must not be the default (all-zero) key")]
    AuthorityIsDefault,

    #[msg("Dispute path is not implemented in v1; see architecture §4.4")]
    DisputeNotImplemented,

    #[msg("Caller is not the registered dispute authority for this adjudicator")]
    NotDisputeAuthority,

    #[msg("Adjudicator has already been disputed; dispute is one-shot per market")]
    AlreadyDisputed,

    #[msg("Market is already settled; dispute can no longer override the outcome")]
    MarketAlreadySettled,

    // ── sooth_book ────────────────────────────────────────────────────────────

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

    // ── sooth_core (new) ──────────────────────────────────────────────────────

    #[msg("Protocol is paused; all state-mutating instructions are disabled")]
    ProtocolPaused,

    #[msg("Adjudicator has not yet attested an outcome for this market")]
    NotYetAttested,

    #[msg("Trading window has not closed yet (now < deadline)")]
    TradingNotClosed,
}
