//! `sooth_book` — on-chain CLOB for Sooth Protocol prediction markets.
//!
//! W3 exposes place-only order entry, cancel, and tick-cleanup instructions
//! on top of the W1 account layout. Matching lands in the next wave.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod bitmap;
pub mod error;
pub mod events;
pub mod instructions;
pub mod matching;
pub mod math;
pub mod state;

pub use error::CoreError;
pub use instructions::*;

declare_id!("DKxaVqA38Y2zvtM2fqoAJJQUPCefSoCL41dCjeACgo5X");

const _: () = assert!(sooth_protocol_types::pubkey_eq(
    crate::ID_CONST,
    sooth_protocol_types::ids::SOOTH_BOOK_PROGRAM_ID,
));

#[program]
pub mod sooth_book {
    use super::*;

    pub fn buy_yes<'info>(
        ctx: Context<'_, '_, '_, 'info, BuyYesOrder<'info>>,
        tick: u16,
        amount: u128,
        escrow: bool,
        match_limit_arg: u32,
    ) -> Result<()> {
        instructions::buy::buy_yes_handler(ctx, tick, amount, escrow, match_limit_arg)
    }

    pub fn buy_no<'info>(
        ctx: Context<'_, '_, '_, 'info, BuyNoOrder<'info>>,
        tick: u16,
        amount: u128,
        escrow: bool,
        match_limit_arg: u32,
    ) -> Result<()> {
        instructions::buy::buy_no_handler(ctx, tick, amount, escrow, match_limit_arg)
    }

    pub fn cancel(ctx: Context<CancelOrder>, side: u8, tick: u16) -> Result<()> {
        instructions::cancel::cancel_handler(ctx, side, tick)
    }

    pub fn cancel_by_id(
        ctx: Context<CancelByIdOrder>,
        order_id: u64,
        side: u8,
        tick: u16,
    ) -> Result<()> {
        instructions::cancel_by_id::cancel_by_id_handler(ctx, order_id, side, tick)
    }

    pub fn compact_book_side(ctx: Context<CompactBookSide>, max_drops: u8) -> Result<()> {
        instructions::compact_book_side::compact_book_side_handler(ctx, max_drops)
    }

    pub fn close_book_side(ctx: Context<CloseBookSide>) -> Result<()> {
        instructions::close_book_side::close_book_side_handler(ctx)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn base_token_mint_matches_feature_cfg() {
        #[cfg(feature = "mainnet")]
        assert_eq!(
            sooth_protocol_types::ids::BASE_TOKEN_MINT,
            sooth_protocol_types::ids::USDC_MINT_MAINNET
        );
        #[cfg(not(feature = "mainnet"))]
        assert_eq!(
            sooth_protocol_types::ids::BASE_TOKEN_MINT,
            sooth_protocol_types::ids::USDC_MINT_DEVNET
        );
    }
}
