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
}
