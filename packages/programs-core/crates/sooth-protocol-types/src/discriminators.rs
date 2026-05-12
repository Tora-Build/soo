//! Anchor instruction discriminators (`sha256("global:<name>")[..8]`) for
//! cross-program ix dispatch and parent-ix introspection.
//!
//! ## Why hard-coded byte arrays
//!
//! On the `cargo build-sbf` toolchain (Anchor 0.30.1 + platform-tools v1.51)
//! anchor-syn's `Discriminator` derive isn't reliable to evaluate at
//! compile time, and `solana_program::hash::Hasher` is not `const fn` so a
//! `const fn anchor_disc(...)` helper isn't an option either. We therefore
//! precompute and pin the bytes here.
//!
//! ## Verification
//!
//! Each constant has a host-side test in
//! `programs/sooth_market/tests/{transfer_helpers,adjudicator_introspection}.rs`
//! that re-hashes `b"global:<name>"` via `solana_program::hash::hash` and
//! asserts equality. Any drift between this file and the on-chain Anchor
//! codegen trips that test on `cargo test -p sooth_market`.
//!
//! Verified once-over against the Anchor IDL JSON in
//! `packages/sdk-solana/src/anchor/sooth_amm.json` and
//! `packages/sdk-solana/src/anchor/sooth_adjudicator.json`
//! (`instructions[].discriminator` arrays).

// ── sooth_amm-owned ix discriminators ────────────────────────────────────

/// `sooth_amm::sell_positions`. Used by
/// `sooth_market::transfer_to_lock` to verify the calling top-level ix is
/// the legitimate AMM dispatcher (closes the auth gap that would otherwise
/// allow a direct `transfer_to_lock` call to drain the vault into
/// lock_vault without producing the matching `LockEntry` mutation).
pub const SELL_POSITIONS_DISCRIMINATOR: [u8; 8] = [3, 151, 9, 138, 95, 252, 50, 39];

/// `sooth_amm::trade_positions`. Used by
/// `sooth_launchpad::mint_lp_for_buy` to verify the calling top-level ix is
/// the legitimate AMM buy dispatcher (closes the auth gap that would
/// otherwise allow a direct `mint_lp_for_buy` call to mint LP tokens to
/// the caller's ATA without producing the matching `Position` mutation).
pub const TRADE_POSITIONS_DISCRIMINATOR: [u8; 8] = [14, 33, 158, 91, 88, 26, 89, 136];

/// `sooth_amm::claim_unlocked`. Companion to `SELL_POSITIONS_DISCRIMINATOR`,
/// gates `sooth_market::transfer_from_lock_vault` to require the legitimate
/// AMM-side claim ix as the top-level dispatcher.
pub const CLAIM_UNLOCKED_DISCRIMINATOR: [u8; 8] = [70, 139, 1, 246, 166, 193, 64, 143];

// ── sooth_adjudicator-owned ix discriminators ────────────────────────────

/// `sooth_adjudicator::request_lock`. Used by
/// `sooth_market::lock_for_resolution` to verify the calling top-level ix
/// originates from the adjudicator program (call-time half of Codex's C2
/// mitigation; the create-time half is the `AdjudicatorAllowlist` PDA gate).
pub const REQUEST_LOCK_DISCRIMINATOR: [u8; 8] = [184, 126, 124, 46, 186, 78, 238, 67];

/// `sooth_adjudicator::attest_outcome`. Companion to
/// `REQUEST_LOCK_DISCRIMINATOR`, gates `sooth_market::settle` to require
/// the legitimate adjudicator-side attestation ix as the dispatcher.
pub const ATTEST_OUTCOME_DISCRIMINATOR: [u8; 8] = [115, 210, 81, 230, 222, 14, 85, 209];

/// `sooth_adjudicator::dispute`. Second-leg veto-path ix that overrides an
/// attested outcome and CPIs into `sooth_market::settle`. Settle's parent-ix
/// introspection accepts either `ATTEST_OUTCOME_DISCRIMINATOR` or
/// `DISPUTE_DISCRIMINATOR` so the dispute path can drive `Locked → Settled`
/// without re-running `attest_outcome` (which is one-shot).
pub const DISPUTE_DISCRIMINATOR: [u8; 8] = [216, 92, 128, 146, 202, 85, 135, 73];

// ── sooth_market-owned helper ix discriminators ──────────────────────────
//
// These two are the helpers being PROTECTED by the parent-ix introspection
// above (not the dispatchers used to pin call-time auth). They live here
// so off-chain transaction builders and any future on-chain code that
// needs to construct CPIs into these ixs can reference the canonical
// bytes without re-deriving from `sha256("global:…")`.

/// `sooth_market::transfer_to_lock`.
pub const TRANSFER_TO_LOCK_DISCRIMINATOR: [u8; 8] = [88, 66, 17, 203, 225, 33, 10, 138];

/// `sooth_market::transfer_from_lock_vault`.
pub const TRANSFER_FROM_LOCK_VAULT_DISCRIMINATOR: [u8; 8] = [48, 17, 136, 127, 104, 131, 136, 169];

/// `sooth_market::transfer_fee_to_market_pool`.
pub const TRANSFER_FEE_TO_MARKET_POOL_DISCRIMINATOR: [u8; 8] =
    [131, 157, 242, 158, 75, 108, 145, 203];

// ── sooth_book-owned ix discriminators ──────────────────────────────────

/// `sooth_book::buy_yes`.
pub const SOOTH_BOOK_BUY_YES_DISCRIMINATOR: [u8; 8] = [124, 76, 113, 130, 177, 112, 187, 104];

/// `sooth_book::buy_no`.
pub const SOOTH_BOOK_BUY_NO_DISCRIMINATOR: [u8; 8] = [89, 240, 244, 16, 196, 201, 190, 163];

/// `sooth_book::cancel`.
pub const SOOTH_BOOK_CANCEL_DISCRIMINATOR: [u8; 8] = [232, 219, 223, 41, 219, 236, 220, 190];

/// `sooth_book::cancel_by_id`.
pub const SOOTH_BOOK_CANCEL_BY_ID_DISCRIMINATOR: [u8; 8] = [188, 241, 240, 50, 95, 134, 33, 127];

// ── sooth_market-owned orderbook filler ix discriminators ───────────────

/// `sooth_market::fill_order`.
pub const SOOTH_MARKET_FILL_ORDER_DISCRIMINATOR: [u8; 8] = [232, 122, 115, 25, 199, 143, 136, 162];

/// `sooth_market::deposit_for_order`.
pub const SOOTH_MARKET_DEPOSIT_FOR_ORDER_DISCRIMINATOR: [u8; 8] =
    [44, 108, 102, 223, 77, 187, 65, 7];

/// `sooth_market::withdraw_for_order`.
pub const SOOTH_MARKET_WITHDRAW_FOR_ORDER_DISCRIMINATOR: [u8; 8] =
    [137, 20, 98, 172, 190, 84, 61, 228];

/// `sooth_market::credit_shares_for_order`.
pub const SOOTH_MARKET_CREDIT_SHARES_FOR_ORDER_DISCRIMINATOR: [u8; 8] =
    [145, 124, 127, 255, 105, 166, 254, 157];

/// `sooth_market::debit_shares_for_order_before_deadline`.
pub const SOOTH_MARKET_DEBIT_SHARES_FOR_ORDER_BEFORE_DEADLINE_DISCRIMINATOR: [u8; 8] =
    [64, 239, 77, 172, 202, 79, 175, 254];

// ── sooth_launchpad-owned fee-pool ix discriminators ────────────────────

/// `sooth_launchpad::init_market_fee_pool`.
pub const SOOTH_LAUNCHPAD_INIT_MARKET_FEE_POOL_DISCRIMINATOR: [u8; 8] =
    [51, 19, 251, 120, 171, 91, 138, 115];

/// `sooth_launchpad::distribute_fees_legacy`.
pub const DISTRIBUTE_FEES_LEGACY_DISCRIMINATOR: [u8; 8] =
    [50, 179, 149, 32, 120, 79, 13, 181];
