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
use crate::events::{AdjudicatorEntryForceCreated, InvalidAttestationForced, MarketSettled};
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
///
/// The entry arrives as an `UncheckedAccount` rather than an
/// `Account<AdjudicatorEntry>` because it MAY NOT EXIST. A market whose
/// creation flow never called `register_adjudicator` has no entry at all, and
/// a typed account would fail to deserialize before the handler ran — which
/// is precisely the shape of the bug that locked funds on devnet: the escape
/// hatch could not open on the markets that most needed it. The address is
/// still pinned by the seed derivation, and the handler checks ownership and
/// the discriminator on any account that does exist.
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

    /// CHECK: address pinned by the seeds; may be an uninitialized system
    /// account, in which case the handler creates it. When it does exist the
    /// handler verifies the owner, the discriminator, the stored `market` and
    /// the stored bump before writing.
    #[account(
        mut,
        seeds = [ADJUDICATOR_ENTRY_SEED, market.key().as_ref()],
        bump,
    )]
    pub adjudicator_entry: UncheckedAccount<'info>,

    /// Whoever cranks it. Unconstrained by design: the whole point is that no
    /// key is required, because the key that was supposed to act is gone.
    ///
    /// `mut` because it pays the entry's rent on the orphaned-market path.
    #[account(mut)]
    pub cranker: Signer<'info>,

    pub system_program: Program<'info, System>,
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
    let market_key = ctx.accounts.market.key();
    let bump = ctx.bumps.adjudicator_entry;
    let entry_ai = ctx.accounts.adjudicator_entry.to_account_info();
    let adjudicator_entry_key = entry_ai.key();
    let cranker = ctx.accounts.cranker.key();

    // Two shapes of the same failure, and the hatch has to open on both. An
    // ABANDONED market has an entry whose adjudicator went quiet; an ORPHANED
    // market never got an entry at all, because the creation flow did not
    // register one. The second case is not rarer — it is what every market
    // created through a UI that skips `register_adjudicator` looks like.
    let created = entry_ai.data_is_empty();

    let mut entry: AdjudicatorEntry = if created {
        create_orphan_entry(&ctx, market_key, bump)?
    } else {
        // An account with data must be one of ours, holding this market's
        // entry, at the bump the seeds derive. Checked here rather than by
        // `Account<…>` because the account type had to be loosened to admit
        // the absent case.
        require_keys_eq!(
            *entry_ai.owner,
            crate::ID,
            SoothCoreError::AdjudicatorEntryOwnerMismatch
        );
        let data = entry_ai.try_borrow_data()?;
        let mut cursor: &[u8] = &data;
        let entry = AdjudicatorEntry::try_deserialize(&mut cursor)?;
        require_keys_eq!(
            entry.market,
            market_key,
            SoothCoreError::AdjudicatorMarketMismatch
        );
        require!(
            entry.bump == bump,
            SoothCoreError::AdjudicatorMarketMismatch
        );
        entry
    };

    // The gate is identical on both paths, and it runs AFTER the creation
    // only because a failing `require` reverts the whole transaction — the
    // account the branch above may have created goes with it. Nothing here
    // is reachable one timeout earlier than it was before.
    assert_forceable(&ctx.accounts.market, &entry, now)?;

    entry.attested_outcome = Some(OUTCOME_INVALID);
    entry.attested_at = Some(now);
    // The marker that keeps this from stealing a market from an
    // adjudicator who is merely late: `attest_outcome` reads it as
    // permission to overwrite.
    entry.forced_invalid = true;

    {
        let mut data = entry_ai.try_borrow_mut_data()?;
        let mut cursor: &mut [u8] = &mut data;
        entry.try_serialize(&mut cursor)?;
    }

    if created {
        emit!(AdjudicatorEntryForceCreated {
            market: market_key,
            adjudicator_entry: adjudicator_entry_key,
            cranker,
            ts: now,
        });
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

/// Bring an orphaned market's `AdjudicatorEntry` into existence, naming
/// nobody.
///
/// ## Why the authorities are the default pubkey
///
/// The entry this writes grants ZERO resolution rights, and that is the whole
/// safety argument. The alternative — pointing `authority` at
/// `market.creator` — reads as generous and is a theft primitive: the creator
/// would gain, retroactively and fourteen days after the deadline, the power
/// to attest any outcome on a market they may hold a position in, on a
/// deployment where `register_adjudicator` never granted them that power. A
/// creator wanting it need only decline to register an adjudicator, wait out
/// the timeout, crank the hatch themselves and then attest YES over the
/// forced INVALID. That is strictly worse than the INVALID it replaced, which
/// pays every holder the 0.50 split.
///
/// So `authority` and `dispute_authority` are both `Pubkey::default()`, the
/// sentinel `AdjudicatorEntry::require_named_authority` refuses. No signature
/// can be checked against them, so:
///
///   - `attest_outcome` cannot write over the forced INVALID,
///   - `dispute` cannot change it,
///   - `lock_for_resolution` and `publish_resolution_commitment` are shut,
///
/// and the market resolves INVALID, which is the honest answer for a market
/// nobody was ever appointed to answer. Note this is the one entry in the
/// program that carries the default pubkey; both registration paths reject it
/// as an argument, so the sentinel is unambiguous.
///
/// The zk fields stay zeroed, so `attest_outcome_zk` reads the entry as
/// manual and refuses with `ZkNotEnabled` — the created entry cannot be used
/// to submit an attestation either.
///
/// `create_pda_account` rather than Anchor's `init` because the entry's
/// address is derivable off chain from the market id, so anyone can park a
/// lamport on it; `init` would then fail forever and the hatch would be
/// censorable by exactly the griefer `crate::pda` already exists to defeat.
fn create_orphan_entry(
    ctx: &Context<ForceInvalidAttestation>,
    market_key: Pubkey,
    bump: u8,
) -> Result<AdjudicatorEntry> {
    crate::pda::create_pda_account(
        &ctx.accounts.cranker.to_account_info(),
        &ctx.accounts.adjudicator_entry.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &Rent::get()?,
        AdjudicatorEntry::SPACE,
        &crate::ID,
        &[ADJUDICATOR_ENTRY_SEED, market_key.as_ref(), &[bump]],
    )?;

    Ok(orphan_entry(market_key, bump))
}

/// The contents the hatch writes into a freshly created entry, as a pure
/// value so the "grants nobody anything" property is testable without a
/// runtime. See [`create_orphan_entry`] for why both authorities are the
/// default pubkey.
pub(crate) fn orphan_entry(market: Pubkey, bump: u8) -> AdjudicatorEntry {
    AdjudicatorEntry {
        market,
        authority: Pubkey::default(),
        dispute_authority: Pubkey::default(),
        attested_outcome: None,
        attested_at: None,
        disputed: false,
        disputed_at: None,
        bump,
        // Left zeroed so `is_zk_enabled()` reads false and
        // `attest_outcome_zk` refuses with `ZkNotEnabled`: the created entry
        // is not a door into the zk path either.
        zk_comparator: 0,
        zk_value_scale: 0,
        zk_attestor_evm: [0; 20],
        zk_rule_hash: [0; 32],
        zk_threshold: 0,
        forced_invalid: false,
        _reserved: [0; 1],
    }
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

#[cfg(test)]
mod orphan_rescue_tests {
    use super::*;
    use crate::state::market::market_fixture;

    fn orphan() -> AdjudicatorEntry {
        orphan_entry(Pubkey::new_unique(), 254)
    }

    #[test]
    fn an_orphaned_market_opens_the_hatch_on_the_same_timeout_as_an_abandoned_one() {
        // The rescue must not be reachable one second earlier than the hatch
        // already was. A market that never had an adjudicator gets exactly
        // the same fourteen days as one whose adjudicator went quiet.
        let market = market_fixture(MarketLifecycle::Locked);
        let entry = orphan();
        let opens_at = market.deadline + ABANDONED_MARKET_TIMEOUT_SECS;
        assert!(assert_forceable(&market, &entry, opens_at - 1).is_err());
        assert!(assert_forceable(&market, &entry, opens_at).is_ok());
    }

    #[test]
    fn an_orphaned_market_still_has_to_be_locked_first() {
        // `request_lock` is what gets it there, and is permissionless after
        // the deadline. Writing an outcome onto a market still trading would
        // be the same fault whether or not it has an entry.
        let market = market_fixture(MarketLifecycle::Open);
        let entry = orphan();
        let opens_at = market.deadline + ABANDONED_MARKET_TIMEOUT_SECS;
        assert!(assert_forceable(&market, &entry, opens_at).is_err());
    }

    #[test]
    fn a_created_entry_hands_nobody_the_right_to_attest() {
        // The abuse question the rescue turns on. Both seats are the default
        // pubkey, which every authority check refuses outright — so the
        // forced INVALID cannot be overwritten with an arbitrary outcome by
        // the cranker, the creator, or anyone else.
        let entry = orphan();
        assert_eq!(entry.authority, Pubkey::default());
        assert_eq!(entry.dispute_authority, Pubkey::default());
        assert!(entry.require_named_authority().is_err());
        assert!(entry.require_named_dispute_authority().is_err());
    }

    #[test]
    fn a_created_entry_is_not_a_door_into_the_zk_path_either() {
        let entry = orphan();
        assert!(!entry.is_zk_enabled());
        assert!(entry.require_zk_rule().is_err());
    }

    #[test]
    fn the_hatch_cannot_fire_twice_on_a_market_it_already_rescued() {
        // The created entry is written with the outcome in the same
        // instruction, so the second call sees an attested entry and is
        // refused — no way to keep restarting the veto window.
        let market = market_fixture(MarketLifecycle::Locked);
        let now = market.deadline + ABANDONED_MARKET_TIMEOUT_SECS;
        let mut entry = orphan();
        assert!(assert_forceable(&market, &entry, now).is_ok());

        entry.attested_outcome = Some(OUTCOME_INVALID);
        entry.attested_at = Some(now);
        entry.forced_invalid = true;
        assert!(assert_forceable(&market, &entry, now + 1).is_err());
    }

    #[test]
    fn a_created_entry_settles_to_invalid_after_the_ordinary_veto_window() {
        // What the rescue buys: the market is settleable, and INVALID is the
        // split every holder can redeem under.
        let market = market_fixture(MarketLifecycle::Locked);
        assert!(assert_settleable(&market).is_ok());
        let mut entry = orphan();
        entry.attested_outcome = Some(OUTCOME_INVALID);
        assert_eq!(entry.attested_outcome, Some(OUTCOME_INVALID));
    }

    #[test]
    fn the_created_entry_is_bound_to_the_market_that_created_it() {
        let market_key = Pubkey::new_unique();
        let entry = orphan_entry(market_key, 251);
        assert_eq!(entry.market, market_key);
        assert_eq!(entry.bump, 251);
        assert!(!entry.is_attested());
        assert!(!entry.is_forced_invalid());
    }
}
