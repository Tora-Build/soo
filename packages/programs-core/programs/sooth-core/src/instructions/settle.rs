//! `settle` — finalize an attested market once its veto window has closed.
//!
//! Permissionless, and takes no outcome argument. Both are deliberate:
//!
//!   - **Permissionless.** The outcome is already fixed on the
//!     `AdjudicatorEntry` by `attest_outcome`; settle only moves the
//!     lifecycle. Requiring the adjudicator to come back would make
//!     finalization — and therefore every redemption — depend on one key
//!     staying live. Mirrors EVM, where `settle(address market)` is callable
//!     by anyone after `vetoEndsAt`.
//!
//!   - **No `winning_outcome` argument.** It is read from the entry, so the
//!     attested value is the only thing that can be finalized. Accepting an
//!     outcome from the caller would make the veto window meaningless:
//!     dispute the attestation all you like, settle could pass something
//!     else.
//!
//! ## The abandonment escape hatch
//!
//! `settle` requires an attested outcome, so an adjudicator who vanishes
//! between the lock and the attestation freezes the market — and with it every
//! position, LP stake and escrowed sell inside it, none of which has a payout
//! path that does not run through settlement. `force_invalid_attestation`,
//! below, is the door out: after [`ABANDONED_MARKET_TIMEOUT_SECS`] past the
//! market's own deadline, ANYONE may write `INVALID` onto the entry, and the
//! ordinary `settle` finalizes it once the ordinary veto window has run.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::error_resolution::ResolutionError;
use crate::events::{InvalidAttestationForced, MarketSettled};
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::{
    AdjudicatorEntry, Market, MarketLifecycle, ProtocolConfig, ADJUDICATOR_ENTRY_SEED,
};

/// How long after a market's DEADLINE anyone may force it to `INVALID`.
///
/// ## Why fourteen days
///
/// The number has to sit above every honest delay and below "the money is
/// gone". An adjudicator resolves manually, so the honest tail includes a
/// long weekend, a public holiday, an event whose official result is itself
/// published late, and a key rotation — days, not hours. Seven days clears a
/// weekend but is still inside the range where "on leave" is an ordinary
/// explanation. Fourteen is not: a market two weeks past its own advertised
/// deadline with no outcome recorded is abandoned by any reasonable reading,
/// and the holders' money has been immobile for a fortnight.
///
/// Nothing is lost by erring long, either, because this is not the only
/// protection: forcing INVALID does not settle anything on its own. It opens
/// the ordinary veto window, so the true resolution can still arrive — by the
/// authority attesting over it, or by the dispute authority correcting it —
/// for `veto_period_secs` afterwards. Worst case the funds are freed at
/// `deadline + 14d + veto`, ~15 days.
///
/// ## Why it runs from the DEADLINE and not from the lock
///
/// Two reasons, and the first is decisive:
///
///   - **The lock time is not recorded.** Neither `Market` nor
///     `AdjudicatorEntry` stores one (`AdjudicatorEntry` has a single spare
///     byte left), so "time since the lock" is not a quantity this program
///     can evaluate at all.
///   - **The deadline is the honest clock even if it were.** A lock may land
///     arbitrarily EARLY — `lock_for_resolution` is deliberately callable the
///     moment the adjudicator believes the answer is known, which can be
///     months before the deadline. A lock-relative timeout would then let a
///     market be voided while its question was still genuinely open, which is
///     a far worse failure than a slow refund. The deadline, by contrast, is
///     advertised at creation and known to everyone who ever traded the
///     market, so a timeout measured from it surprises nobody.
///
/// The cost of the choice: a market locked long before its deadline waits
/// until `deadline + 14d`, not `lock + 14d`. That is the safe direction.
///
/// ## Where this lives
///
/// Beside its only consumer rather than in `constants.rs`. It is not
/// configuration — `ProtocolConfig` has no field for it and adding one would
/// change an account layout — and the reasoning above is the kind that has to
/// travel with the number.
pub const ABANDONED_MARKET_TIMEOUT_SECS: i64 = 14 * 24 * 60 * 60;

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// Per-market adjudicator record; supplies the attested outcome and
    /// timestamp.
    #[account(
        seeds = [ADJUDICATOR_ENTRY_SEED, market.key().as_ref()],
        bump = adjudicator_entry.bump,
        constraint = adjudicator_entry.market == market.key()
            @ SoothCoreError::AdjudicatorMarketMismatch,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Whoever cranks the settle. Unconstrained by design — see module docs.
    /// Present only so the transaction has a signer to pay fees.
    pub cranker: Signer<'info>,
}

/// Settlement is the terminal alternative to dismissal and excludes it.
///
/// A dismissed market refunds every AMM deposit at cost via `claim_refund`;
/// settling it as well would let the same deposit be paid twice out of the one
/// vault. `dismiss_market` holds the other half of this exclusion by refusing
/// to run on anything but an `Open` market.
fn assert_settleable(market: &Market) -> Result<()> {
    require!(!market.is_dismissed, SoothCoreError::MarketDismissed);
    require!(
        market.lifecycle.can_transition_to(MarketLifecycle::Settled),
        SoothCoreError::InvalidLifecycleTransition
    );
    Ok(())
}

pub fn handler(ctx: Context<Settle>) -> Result<()> {
    let entry = &ctx.accounts.adjudicator_entry;

    let winning_outcome = entry
        .attested_outcome
        .ok_or(error!(SoothCoreError::NotYetAttested))?;
    let attested_at = entry
        .attested_at
        .ok_or(error!(SoothCoreError::NotYetAttested))?;

    // Defence in depth: the outcome was validated at attest/dispute time, but
    // this is the value that becomes permanent, so re-check it rather than
    // trusting stored state.
    require!(
        winning_outcome == OUTCOME_NO
            || winning_outcome == OUTCOME_YES
            || winning_outcome == OUTCOME_INVALID,
        SoothCoreError::InvalidOutcome
    );

    let now = Clock::get()?.unix_timestamp;
    let veto_ends_at = attested_at
        .checked_add(ctx.accounts.protocol_config.veto_period_secs)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    require!(now >= veto_ends_at, SoothCoreError::VetoWindowOpen);

    let market = &mut ctx.accounts.market;
    assert_settleable(market)?;
    market.lifecycle = MarketLifecycle::Settled;
    market.winning_outcome = winning_outcome;

    emit!(MarketSettled {
        market: market.key(),
        winning_outcome,
        ts: now,
    });

    Ok(())
}

/// Accounts for the permissionless abandonment escape hatch.
///
/// Same shape as [`Settle`] minus the protocol config, except that the entry
/// is WRITABLE here: this is the one instruction that writes an outcome
/// without an authority signing for it.
#[derive(Accounts)]
pub struct ForceInvalidAttestation<'info> {
    /// Read-only. Forcing an attestation changes no lifecycle — `settle`
    /// still does that, after the veto window, exactly as for an outcome an
    /// adjudicator wrote.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [ADJUDICATOR_ENTRY_SEED, market.key().as_ref()],
        bump = adjudicator_entry.bump,
        constraint = adjudicator_entry.market == market.key()
            @ SoothCoreError::AdjudicatorMarketMismatch,
    )]
    pub adjudicator_entry: Account<'info, AdjudicatorEntry>,

    /// Whoever cranks it. Unconstrained by design: the whole point is that no
    /// key is required, because the key that was supposed to act is gone.
    pub cranker: Signer<'info>,
}

/// Everything the escape hatch requires of chain state, in one place so it is
/// testable without a runtime.
///
/// Four conditions, and each is load-bearing:
///
///   - **Not dismissed.** Dismissal is the other terminal path and refunds at
///     cost; pointing this one at the same vault would pay twice.
///   - **`Locked`.** Trading must already have stopped. Writing an outcome
///     onto an `Open` market would let it be traded knowing how it resolves,
///     and `Locked` is reachable without the adjudicator — `request_lock` is
///     permissionless once the deadline passes.
///   - **Not already attested.** An outcome on record means the adjudicator
///     was not absent; overriding it is `dispute`'s job, not this one's.
///   - **`deadline + ABANDONED_MARKET_TIMEOUT_SECS` elapsed.** See the
///     constant for why the deadline is the clock.
fn assert_forceable(market: &Market, entry: &AdjudicatorEntry, now: i64) -> Result<()> {
    require!(!market.is_dismissed, SoothCoreError::MarketDismissed);
    require!(
        market.lifecycle.can_transition_to(MarketLifecycle::Settled),
        SoothCoreError::InvalidLifecycleTransition
    );
    require!(!entry.is_attested(), SoothCoreError::AlreadyAttested);

    let forceable_at = market
        .deadline
        .checked_add(ABANDONED_MARKET_TIMEOUT_SECS)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    require!(
        now >= forceable_at,
        ResolutionError::AbandonmentTimeoutNotElapsed
    );
    Ok(())
}

/// Record `INVALID` on an abandoned market's entry, so the market can settle.
///
/// ## Why it attests instead of settling
///
/// The obvious shape — "anyone may settle straight to INVALID" — is a theft
/// primitive. Reaching `Locked` is itself permissionless after the deadline,
/// so an attacker could call `request_lock` and settle INVALID in ONE
/// transaction, giving a live adjudicator no instant in which to attest. On a
/// market whose real answer is known, that converts a winner's 1.00 per share
/// into a 0.50 split and pays the loser out of it — a profitable attack, open
/// to anyone, on any market whose lock merely happened late.
///
/// Writing the attestation instead puts the forced outcome through the SAME
/// veto window as any other, which is the only reaction time this program can
/// guarantee without a stored lock timestamp. Inside it:
///
///   - `attest_outcome` lets the real authority write the true outcome over
///     the forced one (that path keys on `forced_invalid`), and
///   - `dispute` lets the dispute authority correct it,
///
/// and either restarts or consumes the window as usual. Only if nobody at all
/// responds does INVALID become final — which is precisely the case the hatch
/// is for.
pub fn force_invalid_handler(ctx: Context<ForceInvalidAttestation>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    assert_forceable(&ctx.accounts.market, &ctx.accounts.adjudicator_entry, now)?;

    let market_key = ctx.accounts.market.key();
    let adjudicator_entry_key = ctx.accounts.adjudicator_entry.key();
    let cranker = ctx.accounts.cranker.key();

    {
        let entry = &mut ctx.accounts.adjudicator_entry;
        entry.attested_outcome = Some(OUTCOME_INVALID);
        entry.attested_at = Some(now);
        // The marker that keeps this from stealing a market from an
        // adjudicator who is merely late: `attest_outcome` reads it as
        // permission to overwrite.
        entry.forced_invalid = true;
    }

    emit!(InvalidAttestationForced {
        market: market_key,
        adjudicator_entry: adjudicator_entry_key,
        cranker,
        deadline: ctx.accounts.market.deadline,
        ts: now,
    });

    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::state::market::market_fixture;

    /// An entry with no outcome on record — the abandoned adjudicator's
    /// signature state.
    pub(crate) fn silent_entry(market: Pubkey) -> AdjudicatorEntry {
        let authority = Pubkey::new_unique();
        AdjudicatorEntry {
            market,
            authority,
            dispute_authority: authority,
            attested_outcome: None,
            attested_at: None,
            disputed: false,
            disputed_at: None,
            bump: 254,
            zk_comparator: 0,
            zk_value_scale: 0,
            zk_attestor_evm: [0; 20],
            zk_rule_hash: [0; 32],
            zk_threshold: 0,
            forced_invalid: false,
            _reserved: [0; 1],
        }
    }

    #[test]
    fn a_locked_market_settles() {
        let market = market_fixture(MarketLifecycle::Locked);
        assert!(assert_settleable(&market).is_ok());
    }

    #[test]
    fn settlement_is_refused_after_dismissal() {
        // The P0 invariant: dismiss → settle → redeem_amm_position would pay a
        // position that claim_refund can also refund, out of the same vault.
        let mut market = market_fixture(MarketLifecycle::Locked);
        market.is_dismissed = true;
        assert!(assert_settleable(&market).is_err());
    }

    #[test]
    fn a_dismissed_open_market_never_reaches_settlement() {
        let mut market = market_fixture(MarketLifecycle::Open);
        market.is_dismissed = true;
        assert!(assert_settleable(&market).is_err());
    }

    #[test]
    fn settlement_is_one_shot() {
        let market = market_fixture(MarketLifecycle::Settled);
        assert!(assert_settleable(&market).is_err());
    }

    #[test]
    fn an_open_market_cannot_skip_the_lock() {
        let market = market_fixture(MarketLifecycle::Open);
        assert!(assert_settleable(&market).is_err());
    }
}

#[cfg(test)]
mod abandonment_tests {
    use super::tests::silent_entry;
    use super::*;
    use crate::state::market::market_fixture;

    fn locked() -> Market {
        market_fixture(MarketLifecycle::Locked)
    }

    /// The instant the hatch opens, for a fixture market.
    fn opens_at(market: &Market) -> i64 {
        market.deadline + ABANDONED_MARKET_TIMEOUT_SECS
    }

    #[test]
    fn an_abandoned_market_cannot_be_forced_before_the_timeout() {
        // The regression: without this bound the hatch would be a public
        // "void this market" button on every live resolution.
        let market = locked();
        let entry = silent_entry(Pubkey::new_unique());
        assert!(assert_forceable(&market, &entry, market.deadline).is_err());
        assert!(assert_forceable(&market, &entry, opens_at(&market) - 1).is_err());
    }

    #[test]
    fn an_abandoned_market_is_forceable_the_second_the_timeout_lands() {
        // The other direction of the same boundary. Inclusive at the instant
        // itself, so there is no second belonging to neither rule.
        let market = locked();
        let entry = silent_entry(Pubkey::new_unique());
        assert!(assert_forceable(&market, &entry, opens_at(&market)).is_ok());
        assert!(assert_forceable(&market, &entry, opens_at(&market) + 1).is_ok());
    }

    #[test]
    fn the_timeout_is_fourteen_days() {
        // Pinned as a number, not just as an expression: this is the length
        // of time a holder's money can sit immobile, and changing it silently
        // is exactly the kind of change that should fail a test.
        assert_eq!(ABANDONED_MARKET_TIMEOUT_SECS, 1_209_600);
    }

    #[test]
    fn an_attested_market_is_never_forced() {
        // An outcome on record means the adjudicator was NOT absent.
        // Overriding it is `dispute`'s job, under its own authority.
        let market = locked();
        let mut entry = silent_entry(Pubkey::new_unique());
        entry.attested_outcome = Some(OUTCOME_YES);
        entry.attested_at = Some(market.deadline);
        assert!(assert_forceable(&market, &entry, opens_at(&market) + 10_000).is_err());
    }

    #[test]
    fn a_market_still_open_is_not_forced_out_from_under_its_traders() {
        // `request_lock` is permissionless after the deadline, so `Locked` is
        // always reachable — but it must actually be reached first, or an
        // outcome would be written onto a market that is still trading.
        let market = market_fixture(MarketLifecycle::Open);
        let entry = silent_entry(Pubkey::new_unique());
        assert!(assert_forceable(&market, &entry, opens_at(&market)).is_err());
    }

    #[test]
    fn a_settled_market_cannot_be_forced_again() {
        let market = market_fixture(MarketLifecycle::Settled);
        let entry = silent_entry(Pubkey::new_unique());
        assert!(assert_forceable(&market, &entry, opens_at(&market)).is_err());
    }

    #[test]
    fn a_dismissed_market_is_refused() {
        // Dismissal refunds at cost out of the same vault a settlement pays
        // from; the two terminal paths must keep excluding each other.
        let mut market = locked();
        market.is_dismissed = true;
        let entry = silent_entry(Pubkey::new_unique());
        assert!(assert_forceable(&market, &entry, opens_at(&market)).is_err());
    }

    #[test]
    fn forcing_does_not_settle_on_its_own() {
        // The property that makes the hatch safe: what it writes is an
        // ATTESTATION, so the veto window still stands between it and a final
        // outcome. `settle` is what finalizes, and only after that window.
        let market = locked();
        let mut entry = silent_entry(Pubkey::new_unique());
        let now = opens_at(&market);
        assert!(assert_forceable(&market, &entry, now).is_ok());

        entry.attested_outcome = Some(OUTCOME_INVALID);
        entry.attested_at = Some(now);
        entry.forced_invalid = true;

        // Same rule `handler` applies: settle refuses until the window shuts.
        let veto = 24 * 60 * 60;
        assert!(now < entry.attested_at.unwrap() + veto);
        // And the market is still Locked — nothing has moved the lifecycle.
        assert!(matches!(market.lifecycle, MarketLifecycle::Locked));
        assert!(assert_settleable(&market).is_ok());
    }

    #[test]
    fn a_forced_outcome_is_invalid_and_a_holder_is_paid_by_the_split() {
        // "A holder actually redeems afterwards", at the level a unit test
        // can reach: the forced outcome is INVALID, and INVALID is the split
        // rule `redeem_amm_position` already implements — so both legs pay,
        // and a holder of the LOSING side is made whole rather than wiped.
        use crate::instructions::redeem_amm_position::consume_position;
        use crate::math::wad::WAD;
        use crate::state::position::position_fixture;

        let mut position = position_fixture();
        position.yes_shares = 6 * WAD;
        position.no_shares = 4 * WAD;
        let claim = consume_position(&mut position, OUTCOME_INVALID).unwrap();
        assert_eq!(
            claim.usdc_payout,
            crate::math::wad_to_base(5 * WAD as u128).unwrap()
        );

        // Nobody is left out: a holder of only the side that would have LOST
        // under a real outcome still redeems half of every share.
        let mut loser = position_fixture();
        loser.no_shares = 4 * WAD;
        let loser_claim = consume_position(&mut loser, OUTCOME_INVALID).unwrap();
        assert_eq!(
            loser_claim.usdc_payout,
            crate::math::wad_to_base(2 * WAD as u128).unwrap()
        );
        assert!(loser_claim.usdc_payout > 0);
    }

    #[test]
    fn the_hatch_cannot_take_a_market_from_a_late_adjudicator() {
        // The griefing case the two-phase shape exists for. Once INVALID is
        // forced, the real authority may still attest over it — `attest_outcome`
        // keys on exactly this flag — and that attestation restarts the veto
        // window.
        let mut entry = silent_entry(Pubkey::new_unique());
        entry.attested_outcome = Some(OUTCOME_INVALID);
        entry.attested_at = Some(1_000);
        entry.forced_invalid = true;
        assert!(entry.is_attested());
        assert!(entry.is_forced_invalid());

        // An outcome an ADJUDICATOR attested carries no such permission.
        let mut honest = silent_entry(Pubkey::new_unique());
        honest.attested_outcome = Some(OUTCOME_YES);
        honest.attested_at = Some(1_000);
        assert!(!honest.is_forced_invalid());
    }
}
