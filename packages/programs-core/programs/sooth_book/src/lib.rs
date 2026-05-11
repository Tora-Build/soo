//! `sooth_book` — on-chain CLOB for Sooth Protocol prediction markets.
//!
//! W1 intentionally exposes no instructions. This crate currently owns only
//! the program identity, bitmap primitive, `MarketBook` layout, and composite
//! order-id codec for the EVM-direct `SoothBook.sol` port.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod bitmap;
pub mod error;
pub mod math;
pub mod state;

declare_id!("DKxaVqA38Y2zvtM2fqoAJJQUPCefSoCL41dCjeACgo5X");

const _: () = assert!(sooth_protocol_types::pubkey_eq(
    crate::ID_CONST,
    sooth_protocol_types::ids::SOOTH_BOOK_PROGRAM_ID,
));

#[program]
pub mod sooth_book {
    #[allow(unused_imports)]
    use super::*;
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
