//! `sooth_book` — program-id reservation for the future Monaco fork.
//!
//! The real orderbook port is intentionally out of scope for this branch.
//! This placeholder reserves the Anchor program shell and fails explicitly
//! on every call so no caller can confuse it with a partial implementation.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

declare_id!("5gAMjRCaZfb4NtHmBf2RZHFJVLAAZQ1PBP6dRNPUTxkH");

#[program]
pub mod sooth_book {
    use super::*;

    pub fn placeholder(ctx: Context<Placeholder>) -> Result<()> {
        let _ = ctx;
        Err(ErrorCode::NotImplemented.into())
    }
}

#[derive(Accounts)]
pub struct Placeholder {}

#[error_code]
pub enum ErrorCode {
    #[msg("sooth_book Monaco fork is not implemented")]
    NotImplemented,
}
