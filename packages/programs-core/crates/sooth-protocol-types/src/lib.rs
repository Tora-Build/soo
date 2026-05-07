//! Shared cross-program constants for the Sooth Solana programs.
//!
//! Centralises the values that would otherwise be duplicated in each
//! program's `lib.rs`:
//!   - Program IDs (`SOOTH_AMM_PROGRAM_ID`, `SOOTH_MARKET_PROGRAM_ID`,
//!     `SOOTH_LAUNCHPAD_PROGRAM_ID`, `SOOTH_ADJUDICATOR_PROGRAM_ID`).
//!   - The canonical devnet USDC mint (`USDC_MINT_DEVNET`).
//!   - Anchor instruction discriminators used by parent-ix introspection.
//!
//! See `Cargo.toml` for the rationale on why these live in their own crate
//! (cyclic-dep avoidance + single source of truth for the values; each
//! program's `declare_id!` still owns the address-of-truth and asserts
//! lock-step with the constants here).
//!
//! Sister crate: `sooth-account-offsets` (byte-offset constants for raw
//! account-data parses).

pub mod discriminators;
pub mod ids;

pub use discriminators::*;
pub use ids::*;

/// Const-fn byte-array equality. Used by each program's
/// `const _: () = assert!(pubkey_eq(crate::ID_CONST, …))` lock-step
/// assertion. `==` on `[u8; 32]` isn't const yet (PartialEq isn't a stable
/// const trait as of Rust 1.84, the toolchain `cargo build-sbf` ships).
pub const fn pubkey_eq(
    a: anchor_lang::solana_program::pubkey::Pubkey,
    b: anchor_lang::solana_program::pubkey::Pubkey,
) -> bool {
    let a = a.to_bytes();
    let b = b.to_bytes();
    let mut i = 0;
    while i < 32 {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}
