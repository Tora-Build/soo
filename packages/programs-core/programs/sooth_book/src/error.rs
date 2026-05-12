use anchor_lang::prelude::*;

#[error_code]
pub enum CoreError {
    #[msg("Tick is outside the supported orderbook range")]
    InvalidTick,
    #[msg("Order id is outside the supported composite encoding range")]
    InvalidOrderId,
    #[msg("Decoded order id does not match the requested side or tick")]
    OrderIdSeedMismatch,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Order amount must be greater than zero")]
    ZeroAmount,
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
    #[msg("Fill return data was not set by sooth_market")]
    MissingFillReturnData,
    #[msg("Fill return data came from the wrong program")]
    WrongFillReturnProgram,
    #[msg("Fill return data could not be decoded")]
    MalformedFillReturnData,
    #[msg("Remaining-account bundle does not carry the crossing BookSide")]
    MissingCrossingBookSide,
    #[msg("Remaining-account bundle maker does not match the live order maker")]
    MakerAccountMismatch,
    #[msg("Remaining-account bundles must contain exactly five accounts per fill")]
    WrongBundleArity,
}
