//! `Market` PDA — lifecycle, outcome, and per-market configuration.

use anchor_lang::prelude::*;

use crate::state::lifecycle::MarketLifecycle;

/// Protocol-wide outcome encoding. 0=NO, 1=YES, 2=INVALID.
pub const OUTCOME_NO: u8 = 0;
pub const OUTCOME_YES: u8 = 1;
pub const OUTCOME_INVALID: u8 = 2;

#[account]
pub struct Market {
    /// Caller-supplied 16-byte id; the seed of this account's PDA and of
    /// every account derived from it. The SDK defaults it to the first 16
    /// bytes of `sha256(question)`, which makes one question resolve to one
    /// market and lets any client derive the PDA from the text alone.
    pub market_id: [u8; 16],
    pub creator: Pubkey,
    /// The adjudicator pubkey recorded at `initialize_market` time. The
    /// adjudicator is also registered as an `AdjudicatorEntry` PDA. This
    /// field remains the canonical source of truth for the market's
    /// designated adjudicator identity.
    pub adjudicator: Pubkey,
    pub question_hash: [u8; 32],
    /// Book-venue collateral vault (`BOOK_TOKEN_MINT`).
    ///
    /// Named per venue: picking the wrong vault is the one mistake here that
    /// fails silently rather than loudly. An SPL token account holds exactly
    /// one mint, so the two vaults cannot be merged.
    pub vault_book: Pubkey,
    /// AMM-venue collateral vault (`AMM_TOKEN_MINT`).
    pub vault_amm: Pubkey,
    /// AMM lock-on-sell escrow vault (`AMM_TOKEN_MINT`) — the sell path's
    /// cooldown holds proceeds here, so it follows the AMM's token.
    pub lock_vault: Pubkey,
    pub start_time: i64,
    pub deadline: i64,
    pub lifecycle: MarketLifecycle,
    /// Set by `settle`. 0=NO, 1=YES, 2=INVALID (only meaningful when
    /// lifecycle == Settled).
    pub winning_outcome: u8,
    /// PDA bumps stored at `initialize_market` time.
    pub bump: u8,
    pub vault_authority_bump: u8,
    pub lock_authority_bump: u8,
    /// Is the orderbook open for this market?
    ///
    /// Mirrors `AmmState.is_graduated`, set once when graduation fires in
    /// `trade_positions`. It lives here rather than being read from
    /// `AmmState` because `book_place` already loads `Market` and does NOT
    /// load `AmmState` — checking the real flag would mean adding an account
    /// and 32 bytes to every order, permanently, to read one bit, and a fill
    /// must cost zero extra accounts.
    ///
    /// The cost of mirroring is that two places hold the same fact. They
    /// cannot drift: graduation is one-way and set at exactly one site.
    pub book_enabled: bool,

    /// Has this market been dismissed?
    ///
    /// Mirrors `AmmState.is_dismissed`, written by `dismiss_market` alongside
    /// it. It lives here because dismissal and settlement are the two terminal
    /// outcomes of one market and must exclude each other: `settle` loads
    /// `Market` and does NOT load `AmmState`, so without the mirror the
    /// exclusion would cost an account and 32 bytes on the settle path — and
    /// the check that is not cheap is the check that gets skipped.
    ///
    /// The two flags cannot drift: dismissal is one-way and set at exactly one
    /// site, `dismiss_market`, which writes both.
    pub is_dismissed: bool,

    /// Forward-compat padding. Adding a field consumes bytes from here
    /// instead of changing the account's length, so no migration is needed:
    /// Solana accounts are fixed-length buffers, and an `#[account]` struct
    /// that outgrows its buffer fails to deserialize on every instruction
    /// that loads it. (Unlike EVM, where appending a storage slot is free.)
    ///
    /// When you add a field, shrink this by exactly its serialized size and
    /// leave `SPACE` unchanged.
    pub _reserved: [u8; 96],
}

impl Market {
    /// Seeds: `[b"market", market_id]` under `sooth_core::ID`.
    pub const SPACE: usize = 8      // discriminator
        + 16                         // market_id
        + 32                         // creator
        + 32                         // adjudicator
        + 32                         // question_hash
        + 32                         // vault_book
        + 32                         // vault_amm
        + 32                         // lock_vault
        + 8                          // start_time
        + 8                          // deadline
        + 1                          // lifecycle (Borsh enum tag)
        + 1                          // winning_outcome
        + 1                          // bump
        + 1                          // vault_authority_bump
        + 1                          // lock_authority_bump
        + 1                          // book_enabled
        + 1                          // is_dismissed
        + 96; // _reserved

    /// Trading is permitted. A dismissed market is never open: dismissal
    /// refunds every deposit at cost, so a trade after it would price shares
    /// that will never pay out.
    pub fn is_open(&self) -> bool {
        matches!(self.lifecycle, MarketLifecycle::Open) && !self.is_dismissed
    }

    pub fn is_locked(&self) -> bool {
        matches!(self.lifecycle, MarketLifecycle::Locked)
    }

    pub fn is_settled(&self) -> bool {
        matches!(self.lifecycle, MarketLifecycle::Settled)
    }
}

/// Fixtures shared by the instruction-level guard tests. Constructing the
/// account struct directly is the only way to exercise a guard without a
/// validator, so the shape lives beside the struct it mirrors.
#[cfg(test)]
pub(crate) fn market_fixture(lifecycle: MarketLifecycle) -> Market {
    Market {
        market_id: [7u8; 16],
        creator: Pubkey::new_unique(),
        adjudicator: Pubkey::new_unique(),
        question_hash: [0u8; 32],
        vault_book: Pubkey::new_unique(),
        vault_amm: Pubkey::new_unique(),
        lock_vault: Pubkey::new_unique(),
        start_time: 0,
        deadline: 1_000,
        lifecycle,
        winning_outcome: OUTCOME_YES,
        bump: 255,
        vault_authority_bump: 254,
        lock_authority_bump: 253,
        book_enabled: false,
        is_dismissed: false,
        _reserved: [0u8; 96],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_constant_is_self_consistent() {
        // Anchor's `init` rents exactly SPACE bytes and never re-checks it
        // against the struct. `is_dismissed` is carved from `_reserved`, so
        // the total must be unchanged — live accounts are fixed-length
        // buffers and a longer struct stops deserializing on every path.
        let expected = 8   // discriminator
            + 16           // market_id
            + 32 * 6       // creator, adjudicator, question_hash, three vaults
            + 8 * 2        // start_time, deadline
            + 7            // lifecycle, winning_outcome, three bumps, two flags
            + 96; // _reserved
        assert_eq!(Market::SPACE, expected);
        assert_eq!(Market::SPACE, 335);
    }

    #[test]
    fn a_dismissed_market_is_not_open() {
        // Every trading path gates on `is_open`, so dismissal closing it is
        // what stops trades against a market whose shares will never pay out.
        let mut market = market_fixture(MarketLifecycle::Open);
        assert!(market.is_open());
        market.is_dismissed = true;
        assert!(!market.is_open());
    }

    #[test]
    fn dismissal_does_not_masquerade_as_settlement() {
        // `redeem_amm_position` keys on `is_settled`; if dismissal set that,
        // a refunded position could also be redeemed.
        let mut market = market_fixture(MarketLifecycle::Open);
        market.is_dismissed = true;
        assert!(!market.is_settled());
        assert!(!market.is_locked());
    }

    #[test]
    fn a_legacy_market_deserializes_with_dismissal_clear() {
        // `_reserved` is zeroed on every account already on chain, and the
        // byte `is_dismissed` now occupies came from it.
        let market = market_fixture(MarketLifecycle::Open);
        let mut bytes = Vec::new();
        AnchorSerialize::serialize(&market, &mut bytes).unwrap();
        assert_eq!(bytes.len(), Market::SPACE - 8);
        let decoded = Market::deserialize(&mut bytes.as_slice()).unwrap();
        assert!(!decoded.is_dismissed);
        assert!(decoded.is_open());
    }
}
