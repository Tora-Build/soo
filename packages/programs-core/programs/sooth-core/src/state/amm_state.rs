//! `AmmState` — per-market LMSR AMM cursor.

use anchor_lang::prelude::*;

use crate::constants::POSITION_TOTAL_LEN;
use crate::error::SoothCoreError;

#[account]
pub struct AmmState {
    /// Backlink to `Market` PDA.
    pub market: Pubkey,
    /// LMSR q_yes — shares outstanding on the YES side.
    pub q_yes: i128,
    /// LMSR q_no — shares outstanding on the NO side.
    pub q_no: i128,
    /// LMSR liquidity parameter `b` (positive i128, stored signed).
    pub b: i128,
    pub seed_q_yes: i128,
    pub seed_q_no: i128,
    /// Accumulated fee WAD for graduation threshold tracking.
    pub fee_b_base_wad: u128,
    /// Trial window end timestamp (architecture §9).
    pub trial_end_at: i64,
    pub is_graduated: bool,
    pub is_dismissed: bool,
    /// PDA bump.
    pub bump: u8,

    /// Aggregate refund obligation: the sum of `Position.locked_cost_usdc`
    /// over every position of this market, in AMM-token base units.
    ///
    /// `claim_refund` pays one position at a time out of a shared vault, so
    /// without a total the program cannot tell whether the vault covers what
    /// it owes. It is maintained at exactly the four sites that move
    /// `locked_cost_usdc`: `trade_positions` (a buy adds its cost),
    /// `sell_positions` (proceeds retire it), `redeem_amm_position`
    /// (settlement clears it), and `claim_refund` (a refund extinguishes it).
    ///
    /// Trustworthy only when `tracks_refund_obligation` is set — see there.
    pub refund_obligation_usdc: u64,

    /// Has this AMM counted `refund_obligation_usdc` since its first trade?
    ///
    /// Set once, by `create_market`. Every account created before the counter
    /// existed reads `false` here and `0` in the counter while real positions
    /// stand behind it, and zero is the OVER-paying direction: it would say
    /// "nothing is owed" to `reclaim_subsidy` and hand the creator collateral
    /// that still backs refunds. So the counter is read as an obligation
    /// total only when this flag is set; when it is clear the counter is
    /// treated as unknown, never as zero.
    pub tracks_refund_obligation: bool,

    /// Has `seed_lp` posted the LMSR subsidy for this market?
    ///
    /// Set once, by `seed_lp`. `create_market` and `seed_lp` are separate
    /// instructions, so between them a market exists with an empty curve;
    /// the trading paths refuse it by this flag. Legacy accounts read `false`
    /// while being genuinely seeded, so the trading paths do not read it
    /// alone — see `is_seeded_with`.
    pub is_seeded: bool,

    /// Forward-compat padding. Adding a field consumes bytes from here
    /// instead of changing the account's length, so no migration is needed:
    /// Solana accounts are fixed-length buffers, and an `#[account]` struct
    /// that outgrows its buffer fails to deserialize on every instruction
    /// that loads it. (Unlike EVM, where appending a storage slot is free.)
    ///
    /// When you add a field, shrink this by exactly its serialized size and
    /// leave `SPACE` unchanged.
    pub _reserved: [u8; 54],
}

impl AmmState {
    /// Seeds: `[b"amm", market_id]` under `sooth_core::ID`.
    pub const SPACE: usize = 8     // discriminator
        + 32                       // market
        + 16                       // q_yes
        + 16                       // q_no
        + 16                       // b
        + 16                       // seed_q_yes
        + 16                       // seed_q_no
        + 16                       // fee_b_base_wad
        + 8                        // trial_end_at
        + 1                        // is_graduated
        + 1                        // is_dismissed
        + 1                        // bump
        + 8                        // refund_obligation_usdc
        + 1                        // tracks_refund_obligation
        + 1                        // is_seeded
        + 54; // _reserved
}

impl AmmState {
    /// Is this market's LMSR curve funded, and therefore tradeable?
    ///
    /// `is_seeded` is authoritative for every market created since the flag
    /// existed. Accounts predating it read `false` while being seeded, so a
    /// positive AMM-vault balance stands in as the witness: `seed_lp`'s
    /// deposit is the vault's first inflow, and a market that never seeded and
    /// never traded holds nothing.
    ///
    /// The witness is a fallback, not the guard. Anyone may transfer tokens
    /// into a vault, so a donation can make an unseeded market look seeded
    /// here — and still not trade: `trade_positions` also requires the LP mint
    /// account, which only `seed_lp` creates, so the buy path is barred by an
    /// account that cannot be conjured. This check is what turns that bar into
    /// a named error, and what closes the sell path, which loads no LP mint.
    pub fn is_seeded_with(&self, amm_vault_amount: u64) -> bool {
        self.is_seeded || amm_vault_amount > 0
    }

    /// A buy joins the market-wide refund obligation.
    ///
    /// Checked, not saturating: `refund_obligation_usdc` is a total the refund
    /// path divides by, and one that silently pinned at `u64::MAX` would make
    /// every later claim round to nothing.
    pub fn accrue_refund_obligation(&mut self, cost_usdc: u64) -> Result<()> {
        self.refund_obligation_usdc = self
            .refund_obligation_usdc
            .checked_add(cost_usdc)
            .ok_or(error!(SoothCoreError::MathOverflow))?;
        Ok(())
    }

    /// A claim leaves the total — paid, sold off, or settled away.
    ///
    /// Saturating, because an account written before the counter existed
    /// carries positions it never counted: its total can sit below a claim
    /// being retired, and failing there would strand the sell and settlement
    /// paths on every market already live. Clamping at zero only ever
    /// under-states a total already marked untrustworthy by
    /// `tracks_refund_obligation`.
    pub fn retire_refund_obligation(&mut self, amount_usdc: u64) {
        self.refund_obligation_usdc = self.refund_obligation_usdc.saturating_sub(amount_usdc);
    }
}

/// A market may only trade once its LMSR subsidy is posted.
///
/// The guard both trading paths run, so the two cannot disagree about what
/// "seeded" means. `amm_vault_amount` is the AMM vault's balance, which is the
/// witness legacy accounts are read through — see `is_seeded_with`.
pub fn require_seeded(amm: &AmmState, amm_vault_amount: u64) -> Result<()> {
    require!(
        amm.is_seeded_with(amm_vault_amount),
        SoothCoreError::MarketNotSeeded
    );
    Ok(())
}

/// Layout sync guard: pins `POSITION_TOTAL_LEN` in `constants.rs` so the
/// `Position` layout cannot drift from the offsets used by raw parsers.
const _: () = assert!(POSITION_TOTAL_LEN == 153);

/// Fixture for the instruction-level guard tests: a live, ungraduated AMM
/// whose trial window has already closed.
#[cfg(test)]
pub(crate) fn amm_fixture() -> AmmState {
    AmmState {
        market: Pubkey::new_unique(),
        q_yes: 0,
        q_no: 0,
        b: 1,
        seed_q_yes: 0,
        seed_q_no: 0,
        fee_b_base_wad: 0,
        trial_end_at: 1_000,
        is_graduated: false,
        is_dismissed: false,
        bump: 255,
        refund_obligation_usdc: 0,
        tracks_refund_obligation: true,
        is_seeded: true,
        _reserved: [0u8; 54],
    }
}

/// The same AMM as `amm_fixture`, as it deserializes off an account written
/// before either new field existed: the bytes they occupy came out of
/// `_reserved`, so both read zero.
#[cfg(test)]
pub(crate) fn legacy_amm_fixture() -> AmmState {
    AmmState {
        refund_obligation_usdc: 0,
        tracks_refund_obligation: false,
        is_seeded: false,
        ..amm_fixture()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_is_unchanged_by_the_new_fields() {
        // Live accounts are fixed-length buffers: `refund_obligation_usdc`,
        // `tracks_refund_obligation` and `is_seeded` come OUT of `_reserved`,
        // so the total must not move or every deployed AmmState stops
        // deserializing.
        assert_eq!(AmmState::SPACE, 8 + 32 + 16 * 6 + 8 + 3 + 8 + 2 + 54);
        assert_eq!(AmmState::SPACE, 211);
        let mut bytes = Vec::new();
        AnchorSerialize::serialize(&amm_fixture(), &mut bytes).unwrap();
        assert_eq!(bytes.len(), AmmState::SPACE - 8);
    }

    #[test]
    fn a_legacy_account_deserializes_with_both_fields_clear() {
        // Everything already on chain has zeroes where the new fields now sit.
        let legacy = legacy_amm_fixture();
        let mut bytes = Vec::new();
        AnchorSerialize::serialize(&legacy, &mut bytes).unwrap();
        let decoded = AmmState::deserialize(&mut bytes.as_slice()).unwrap();
        assert_eq!(decoded.refund_obligation_usdc, 0);
        assert!(!decoded.tracks_refund_obligation);
        assert!(!decoded.is_seeded);
    }

    #[test]
    fn a_legacy_seeded_market_still_trades() {
        // The crux of the seeding gate: every market live on devnet reads
        // `is_seeded == false`, and a naive `require!(is_seeded)` would brick
        // all of them. A seeded market's vault holds its subsidy, which is the
        // witness.
        let legacy = legacy_amm_fixture();
        assert!(legacy.is_seeded_with(1), "a funded vault is the witness");
        assert!(!legacy.is_seeded_with(0), "an empty vault is not");
    }

    #[test]
    fn a_seeded_flag_stands_alone() {
        // A market seeded since the flag existed trades even at the instant
        // its vault is empty, which the flag — not the balance — proves.
        let amm = amm_fixture();
        assert!(amm.is_seeded_with(0));
    }
}
