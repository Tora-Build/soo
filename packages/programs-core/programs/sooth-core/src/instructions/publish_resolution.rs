//! `publish_resolution_commitment` / `revoke_resolution_commitment` — the
//! adjudicator's commitment to a T\* voiding computation, and the veto over it.
//!
//! The mechanism and its trust model are in `docs/design/t-star-voiding.md`.
//! What matters here is the timing, because the timing IS the enforcement:
//!
//!   - Publication is only accepted while the market is `Locked`, the outcome
//!     is attested, and the veto window is still OPEN. So a commitment always
//!     lands in front of the same 24h of public scrutiny as the outcome it
//!     accompanies, and always before `settle` — which is the first moment any
//!     position can redeem against it.
//!   - Revocation is only accepted inside that same window. After it closes
//!     the commitment is final, exactly as the outcome is.
//!
//! A published root is not trusted, it is CHECKABLE: the leaf table is a pure
//! function of the market's public event tape, so any observer can recompute
//! the root and see that it differs. `revoke_resolution_commitment` is what
//! they can then have the dispute authority do — after which the market
//! redeems as if voiding had never been attempted.
//!
//! Publication is one-shot: the PDA is created with `init`, so a second call
//! fails on the account already existing. Amending a commitment mid-window
//! would let a resolver publish a decoy, wait out the observers, and swap it.

use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

use crate::book::account::load_book;
use crate::error::SoothCoreError;
use crate::error_resolution::ResolutionError;
use crate::events::{ResolutionCommitmentPublished, ResolutionCommitmentRevoked};
use crate::instructions::redeem_amm_position::settled_payout;
use crate::state::resolution::{ResolutionCommitment, RESOLUTION_COMMITMENT_SEED};
use crate::state::{
    AdjudicatorEntry, AmmState, Market, MarketLifecycle, ProtocolConfig, ADJUDICATOR_ENTRY_SEED,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct PublishResolutionCommitmentArgs {
    /// Root of the per-wallet entitlement tree.
    pub merkle_root: [u8; 32],
    /// The moment the market's event became public knowledge.
    pub t_star: i64,
    /// Leaves in the tree. Published so the tree's shape is reproducible.
    pub leaf_count: u32,
    /// Ceiling on the USDC the AMM void path may pay out across every leaf.
    pub total_void_refund_usdc: u64,
    /// The same ceiling for the BOOK venue, whose refunds leave a different
    /// vault. Zero on a market that never graduated — and a market with no
    /// book account may publish nothing else.
    pub total_book_void_refund_usdc: u64,
}

#[derive(Accounts)]
pub struct PublishResolutionCommitment<'info> {
    /// One per market, created once. `init` (not `init_if_needed`) is the
    /// one-shot guard.
    #[account(
        init,
        payer = authority,
        space = ResolutionCommitment::SPACE,
        seeds = [RESOLUTION_COMMITMENT_SEED, market.key().as_ref()],
        bump,
    )]
    pub resolution_commitment: Account<'info, ResolutionCommitment>,

    /// Read-only: a commitment changes no lifecycle. `settle` still does that.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// Supplies the attestation timestamp the veto window is measured from,
    /// and the authority allowed to publish.
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

    /// Read-only. Supplies the outstanding share ledger the solvency bound
    /// below is computed against.
    #[account(
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// The cash the AMM's claims are payable from. Read-only — publication
    /// moves no money; it only refuses to promise more than this holds.
    #[account(address = market.vault_amm @ SoothCoreError::VaultAuthorityMismatch)]
    pub vault_amm: Box<Account<'info, TokenAccount>>,

    /// CHECK: raw zero-copy book, and OPTIONAL in practice — a market that
    /// never graduated has no book account. Emptiness is read as "no book
    /// obligations", and a commitment that claims a book refund on such a
    /// market is refused rather than believed.
    #[account(seeds = [b"book", market.market_id.as_ref()], bump)]
    pub book: UncheckedAccount<'info>,

    #[account(address = market.vault_book @ SoothCoreError::VaultAuthorityMismatch)]
    pub vault_book: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeResolutionCommitment<'info> {
    /// Closed, with the rent returned to whoever paid it. Closing is the
    /// whole point: `redeem_amm_position` reads an absent account as "no
    /// voiding", so revocation restores the market's pre-commitment payout
    /// without needing a flag anywhere.
    #[account(
        mut,
        close = publisher,
        seeds = [RESOLUTION_COMMITMENT_SEED, market.key().as_ref()],
        bump = resolution_commitment.bump,
        constraint = resolution_commitment.market == market.key()
            @ ResolutionError::CommitmentMarketMismatch,
    )]
    pub resolution_commitment: Account<'info, ResolutionCommitment>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

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

    /// CHECK: rent recipient, pinned to the address recorded at publish time.
    /// Refunding anyone else would let a revoker pay themselves out of the
    /// publisher's deposit.
    #[account(
        mut,
        address = resolution_commitment.publisher @ SoothCoreError::Unauthorized,
    )]
    pub publisher: UncheckedAccount<'info>,

    pub dispute_authority: Signer<'info>,
}

/// The instant the veto window shuts, from the attestation that opened it.
///
/// Derived from `attested_at` rather than from "now", so a commitment
/// published at the last second gets the scrutiny that is LEFT, not a fresh
/// window of its own.
fn veto_ends_at(entry: &AdjudicatorEntry, veto_period_secs: i64) -> Result<i64> {
    let attested_at = entry
        .attested_at
        .ok_or(error!(SoothCoreError::NotYetAttested))?;
    attested_at
        .checked_add(veto_period_secs)
        .ok_or(error!(SoothCoreError::MathOverflow))
}

/// Everything publication requires of chain state, in one place so it is
/// testable without a runtime.
///
/// The market must be `Locked` AND unsettled AND undismissed AND attested AND
/// inside the veto window — the conjunction is the point. `Locked` alone would
/// admit a commitment before any outcome existed; "attested" alone would admit
/// one after settlement, when positions may already have redeemed at full
/// value and voiding could only be applied to whoever was slowest.
pub(crate) fn assert_publishable(
    market: &Market,
    entry: &AdjudicatorEntry,
    veto_period_secs: i64,
    now: i64,
) -> Result<()> {
    require!(!market.is_dismissed, SoothCoreError::MarketDismissed);
    require!(
        matches!(market.lifecycle, MarketLifecycle::Locked),
        SoothCoreError::InvalidLifecycleTransition
    );
    require!(entry.is_attested(), SoothCoreError::NotYetAttested);
    require!(
        now < veto_ends_at(entry, veto_period_secs)?,
        SoothCoreError::VetoWindowClosed
    );
    Ok(())
}

/// Everything publication requires of its ARGUMENTS.
///
/// `t_star` is bounded by state the program already holds: it cannot precede
/// the market's own start, and it cannot follow the attestation that claims to
/// have observed the event (nor the deadline, past which the market's question
/// is moot). Those bounds do not make a T\* correct — only public evidence and
/// the veto window do that — but they rule out the degenerate values, notably
/// a T\* at or before `start_time`, which would void every trade the market
/// ever saw.
pub(crate) fn assert_commitment_args_valid(
    market: &Market,
    entry: &AdjudicatorEntry,
    args: &PublishResolutionCommitmentArgs,
) -> Result<()> {
    require!(
        args.merkle_root != [0u8; 32],
        ResolutionError::ZeroMerkleRoot
    );
    require!(args.leaf_count > 0, ResolutionError::EmptyCommitment);

    let attested_at = entry
        .attested_at
        .ok_or(error!(SoothCoreError::NotYetAttested))?;
    let upper = attested_at.min(market.deadline);
    require!(
        args.t_star > market.start_time && args.t_star <= upper,
        ResolutionError::InvalidTStar
    );
    Ok(())
}

/// One unit per share still owed by the AMM ledger under `winning_outcome`.
///
/// `q_*` includes the seed inventory the subsidy bought, which nobody holds,
/// so it is subtracted. Saturating: a negative would mean corrupt state, and
/// clamping at zero OVER-counts the obligation, which is the safe direction
/// for a solvency check.
fn amm_ledger_obligations(amm: &AmmState, winning_outcome: u8) -> Result<u64> {
    let user_q_yes = amm.q_yes.saturating_sub(amm.seed_q_yes).max(0) as u128;
    let user_q_no = amm.q_no.saturating_sub(amm.seed_q_no).max(0) as u128;
    settled_payout(winning_outcome, user_q_yes, user_q_no)
}

/// The solvency bound: a commitment may not promise more than the vaults hold.
///
/// ## What it proves, and what it does not
///
/// Refunding a voided buyer at cost while retiring their shares is the right
/// economics — it undoes the trade — but LMSR is path-independent for the POOL,
/// not for a mid-path unwind at historical cost. So refunds at cost plus
/// payouts to the remaining valid winners can in principle exceed the vault,
/// and the published total alone only made that risk VISIBLE.
///
/// This makes it a precondition instead. For each venue:
///
/// ```text
/// vault >= published_refund_ceiling + everything the ledger still owes
/// ```
///
/// The right-hand side is an UPPER bound on what the market can pay after
/// voiding, because voiding only ever moves a share from "settles" to
/// "refunded": `Σ payout(valid) <= payout(outstanding)` by the per-leaf bound
/// `valid <= held` that redemption enforces, and every refund is capped by the
/// ceiling. So a commitment that passes here cannot promise the vault into
/// deficit, and one that would fail is refused — after which the market
/// redeems unvoided, which is the same safe degradation as never publishing.
///
/// It is CONSERVATIVE, deliberately. A voided share is counted twice: once at
/// full value in the outstanding ledger, and again inside the refund ceiling.
/// The slack is bounded by the voided volume, which is exactly the quantity a
/// well-chosen T\* keeps small. Refusing an honest-but-large commitment costs
/// the voiding; accepting an insolvent one costs somebody their redemption.
///
/// What it does NOT do is hold the bound open FOREVER. It is checked at
/// publication; the junior paths that can later take money out of the AMM
/// vault — `reclaim_subsidy`, `redeem_lp` — compute their residual from the
/// share ledger alone and know nothing about a refund ceiling, so a creator
/// reclaiming after publication can still drain the room this check found.
/// Closing that needs the refund ceiling subtracted inside those two
/// instructions.
pub(crate) fn assert_commitment_fits_the_vaults(
    amm: &AmmState,
    vault_amm_amount: u64,
    book_obligations: u64,
    vault_book_amount: u64,
    winning_outcome: u8,
    args: &PublishResolutionCommitmentArgs,
) -> Result<()> {
    let amm_needed = amm_ledger_obligations(amm, winning_outcome)?
        .checked_add(args.total_void_refund_usdc)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    require!(
        vault_amm_amount >= amm_needed,
        ResolutionError::CommitmentExceedsVault
    );

    let book_needed = book_obligations
        .checked_add(args.total_book_void_refund_usdc)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    require!(
        vault_book_amount >= book_needed,
        ResolutionError::CommitmentExceedsVault
    );
    Ok(())
}

pub fn publish_handler(
    ctx: Context<PublishResolutionCommitment>,
    args: PublishResolutionCommitmentArgs,
) -> Result<()> {
    ctx.accounts.adjudicator_entry.require_named_authority()?;
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.adjudicator_entry.authority,
        SoothCoreError::Unauthorized
    );

    let now = Clock::get()?.unix_timestamp;
    assert_publishable(
        &ctx.accounts.market,
        &ctx.accounts.adjudicator_entry,
        ctx.accounts.protocol_config.veto_period_secs,
        now,
    )?;
    assert_commitment_args_valid(&ctx.accounts.market, &ctx.accounts.adjudicator_entry, &args)?;

    // The outcome is on record by now — `assert_publishable` required the
    // attestation — so the solvency bound can be computed against the very
    // rule redemption will apply.
    let winning_outcome = ctx
        .accounts
        .adjudicator_entry
        .attested_outcome
        .ok_or(error!(SoothCoreError::NotYetAttested))?;

    // The walk is O(seats + resting orders) — the only whole-book traversal
    // in the program — which is affordable precisely because publication
    // happens at most once per market, on a path no trade waits behind.
    //
    // An absent book account is "no book", not an omission: `book_init` only
    // runs on markets that graduated. A commitment claiming book refunds on a
    // market with no book has nothing to refund from, so it is refused by the
    // zero obligation and zero vault below.
    let book_obligations = {
        let info = ctx.accounts.book.to_account_info();
        if info.data_is_empty() {
            0u64
        } else {
            let mut data = info.try_borrow_mut_data()?;
            let book =
                load_book(&mut data).map_err(|_| error!(SoothCoreError::InvalidBookAccount))?;
            book.total_obligations(winning_outcome)
                .map_err(|_| error!(SoothCoreError::InvalidBookAccount))?
        }
    };

    assert_commitment_fits_the_vaults(
        &ctx.accounts.amm_state,
        ctx.accounts.vault_amm.amount,
        book_obligations,
        ctx.accounts.vault_book.amount,
        winning_outcome,
        &args,
    )?;

    let market_key = ctx.accounts.market.key();
    let publisher = ctx.accounts.authority.key();

    let commitment = &mut ctx.accounts.resolution_commitment;
    commitment.market = market_key;
    commitment.merkle_root = args.merkle_root;
    commitment.t_star = args.t_star;
    commitment.leaf_count = args.leaf_count;
    commitment.total_void_refund_usdc = args.total_void_refund_usdc;
    commitment.void_refund_paid_usdc = 0;
    commitment.total_book_void_refund_usdc = args.total_book_void_refund_usdc;
    commitment.book_void_refund_paid_usdc = 0;
    commitment.publisher = publisher;
    commitment.published_at = now;
    commitment.bump = ctx.bumps.resolution_commitment;
    commitment._reserved = [0u8; 16];

    emit!(ResolutionCommitmentPublished {
        market: market_key,
        publisher,
        merkle_root: args.merkle_root,
        t_star: args.t_star,
        leaf_count: args.leaf_count,
        total_void_refund_usdc: args.total_void_refund_usdc,
        total_book_void_refund_usdc: args.total_book_void_refund_usdc,
        ts: now,
    });

    Ok(())
}

/// The dispute authority's guard on publication: same window as `dispute`,
/// same one-key veto, applied to the entitlement tree instead of the outcome.
///
/// Deliberately NOT one-shot the way `dispute` is. `dispute` records that it
/// fired because it MUTATES an outcome and a second mutation would be a
/// second bite; revoking merely deletes, and deleting twice is impossible —
/// the account is gone.
pub(crate) fn assert_revocable(
    market: &Market,
    entry: &AdjudicatorEntry,
    veto_period_secs: i64,
    now: i64,
) -> Result<()> {
    require!(
        !matches!(market.lifecycle, MarketLifecycle::Settled),
        SoothCoreError::MarketAlreadySettled
    );
    require!(
        now < veto_ends_at(entry, veto_period_secs)?,
        SoothCoreError::VetoWindowClosed
    );
    Ok(())
}

pub fn revoke_handler(ctx: Context<RevokeResolutionCommitment>) -> Result<()> {
    ctx.accounts
        .adjudicator_entry
        .require_named_dispute_authority()?;
    require_keys_eq!(
        ctx.accounts.dispute_authority.key(),
        ctx.accounts.adjudicator_entry.dispute_authority,
        SoothCoreError::Unauthorized
    );

    let now = Clock::get()?.unix_timestamp;
    assert_revocable(
        &ctx.accounts.market,
        &ctx.accounts.adjudicator_entry,
        ctx.accounts.protocol_config.veto_period_secs,
        now,
    )?;

    emit!(ResolutionCommitmentRevoked {
        market: ctx.accounts.market.key(),
        dispute_authority: ctx.accounts.dispute_authority.key(),
        merkle_root: ctx.accounts.resolution_commitment.merkle_root,
        ts: now,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::market::market_fixture;
    use crate::zk::ZkComparator;

    const VETO: i64 = 86_400;
    const ATTESTED_AT: i64 = 900;

    /// An entry attested at `ATTESTED_AT`, which is inside the fixture
    /// market's [start_time=0, deadline=1000].
    fn attested_entry() -> AdjudicatorEntry {
        let authority = Pubkey::new_unique();
        AdjudicatorEntry {
            market: Pubkey::new_unique(),
            authority,
            dispute_authority: authority,
            attested_outcome: Some(1),
            attested_at: Some(ATTESTED_AT),
            disputed: false,
            disputed_at: None,
            bump: 254,
            zk_comparator: ZkComparator::None as u8,
            zk_value_scale: 0,
            zk_attestor_evm: [0; 20],
            zk_rule_hash: [0; 32],
            zk_threshold: 0,
            forced_invalid: false,
            _reserved: [0; 1],
        }
    }

    fn args() -> PublishResolutionCommitmentArgs {
        PublishResolutionCommitmentArgs {
            merkle_root: [9u8; 32],
            t_star: 500,
            leaf_count: 3,
            total_void_refund_usdc: 1_000_000,
            total_book_void_refund_usdc: 0,
        }
    }

    #[test]
    fn a_locked_attested_market_inside_the_window_may_publish() {
        let market = market_fixture(MarketLifecycle::Locked);
        let entry = attested_entry();
        assert!(assert_publishable(&market, &entry, VETO, ATTESTED_AT + 1).is_ok());
    }

    #[test]
    fn publication_is_refused_before_any_attestation() {
        // Without an attestation there is no window, so a commitment would
        // sit unscrutinised until whenever the attestation eventually landed.
        let market = market_fixture(MarketLifecycle::Locked);
        let mut entry = attested_entry();
        entry.attested_outcome = None;
        entry.attested_at = None;
        assert!(assert_publishable(&market, &entry, VETO, ATTESTED_AT + 1).is_err());
    }

    #[test]
    fn publication_is_refused_once_the_veto_window_has_closed() {
        // The invariant that makes the whole design accountable: a commitment
        // nobody had time to check must not be able to pay anyone.
        let market = market_fixture(MarketLifecycle::Locked);
        let entry = attested_entry();
        assert!(assert_publishable(&market, &entry, VETO, ATTESTED_AT + VETO).is_err());
        assert!(assert_publishable(&market, &entry, VETO, ATTESTED_AT + VETO + 1).is_err());
        // The last second inside the window still counts.
        assert!(assert_publishable(&market, &entry, VETO, ATTESTED_AT + VETO - 1).is_ok());
    }

    #[test]
    fn publication_is_refused_after_settlement() {
        // Settlement is what makes redemption reachable. A commitment landing
        // afterwards would void only the positions that had not yet redeemed.
        let market = market_fixture(MarketLifecycle::Settled);
        let entry = attested_entry();
        assert!(assert_publishable(&market, &entry, VETO, ATTESTED_AT + 1).is_err());
    }

    #[test]
    fn publication_is_refused_on_an_open_market() {
        let market = market_fixture(MarketLifecycle::Open);
        let entry = attested_entry();
        assert!(assert_publishable(&market, &entry, VETO, ATTESTED_AT + 1).is_err());
    }

    #[test]
    fn publication_is_refused_on_a_dismissed_market() {
        // A dismissed market refunds every deposit at cost via `claim_refund`;
        // there is nothing left for a void refund to pay a second time.
        let mut market = market_fixture(MarketLifecycle::Locked);
        market.is_dismissed = true;
        let entry = attested_entry();
        assert!(assert_publishable(&market, &entry, VETO, ATTESTED_AT + 1).is_err());
    }

    #[test]
    fn a_zero_root_is_refused() {
        // An all-zero account reads as a zero root, so accepting one would
        // make an uninitialised-looking commitment verifiable.
        let market = market_fixture(MarketLifecycle::Locked);
        let entry = attested_entry();
        let mut a = args();
        a.merkle_root = [0u8; 32];
        assert!(assert_commitment_args_valid(&market, &entry, &a).is_err());
    }

    #[test]
    fn an_empty_tree_is_refused() {
        let market = market_fixture(MarketLifecycle::Locked);
        let entry = attested_entry();
        let mut a = args();
        a.leaf_count = 0;
        assert!(assert_commitment_args_valid(&market, &entry, &a).is_err());
    }

    #[test]
    fn t_star_must_be_after_the_market_opened() {
        // A T* at or before the start voids every trade the market ever saw —
        // a total confiscation dressed up as a correction.
        let market = market_fixture(MarketLifecycle::Locked);
        let entry = attested_entry();
        let mut a = args();
        a.t_star = market.start_time;
        assert!(assert_commitment_args_valid(&market, &entry, &a).is_err());
        a.t_star = market.start_time - 1;
        assert!(assert_commitment_args_valid(&market, &entry, &a).is_err());
        a.t_star = market.start_time + 1;
        assert!(assert_commitment_args_valid(&market, &entry, &a).is_ok());
    }

    #[test]
    fn t_star_may_not_follow_the_attestation() {
        // T* is when the event happened; the attestation is someone noticing.
        // The second cannot precede the first.
        let mut market = market_fixture(MarketLifecycle::Locked);
        market.deadline = i64::MAX;
        let entry = attested_entry();
        let mut a = args();
        a.t_star = ATTESTED_AT;
        assert!(assert_commitment_args_valid(&market, &entry, &a).is_ok());
        a.t_star = ATTESTED_AT + 1;
        assert!(assert_commitment_args_valid(&market, &entry, &a).is_err());
    }

    #[test]
    fn t_star_may_not_follow_the_deadline() {
        // Past the deadline the question is moot and nothing is left to void.
        let market = market_fixture(MarketLifecycle::Locked);
        let mut entry = attested_entry();
        entry.attested_at = Some(i64::MAX);
        let mut a = args();
        a.t_star = market.deadline;
        assert!(assert_commitment_args_valid(&market, &entry, &a).is_ok());
        a.t_star = market.deadline + 1;
        assert!(assert_commitment_args_valid(&market, &entry, &a).is_err());
    }

    #[test]
    fn revocation_tracks_the_same_window_as_publication() {
        let market = market_fixture(MarketLifecycle::Locked);
        let entry = attested_entry();
        assert!(assert_revocable(&market, &entry, VETO, ATTESTED_AT + 1).is_ok());
        assert!(assert_revocable(&market, &entry, VETO, ATTESTED_AT + VETO).is_err());
    }

    #[test]
    fn revocation_is_refused_after_settlement() {
        // Once settled the commitment is final in both directions: nobody can
        // add one, and nobody can take one away from holders redeeming under it.
        let market = market_fixture(MarketLifecycle::Settled);
        let entry = attested_entry();
        assert!(assert_revocable(&market, &entry, VETO, ATTESTED_AT + 1).is_err());
    }

    #[test]
    fn a_veto_period_that_would_overflow_is_refused_not_wrapped() {
        let market = market_fixture(MarketLifecycle::Locked);
        let mut entry = attested_entry();
        entry.attested_at = Some(i64::MAX);
        assert!(assert_publishable(&market, &entry, VETO, 0).is_err());
        assert!(assert_revocable(&market, &entry, VETO, 0).is_err());
    }
}

#[cfg(test)]
mod solvency_tests {
    use super::*;
    use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};

    /// One share in WAD, matching `AmmState`'s units.
    const WAD: i128 = 1_000_000_000_000_000_000;
    /// The same share in the base units a vault holds.
    const BASE: u64 = 1_000_000;

    fn amm(q_yes: i128, q_no: i128) -> AmmState {
        AmmState {
            market: Pubkey::new_unique(),
            q_yes,
            q_no,
            b: 10 * WAD,
            // A seeded curve nobody holds: subtracted from the ledger, so
            // these shares are never counted as an obligation.
            seed_q_yes: 2 * WAD,
            seed_q_no: 2 * WAD,
            fee_b_base_wad: 0,
            trial_end_at: 0,
            is_graduated: false,
            is_dismissed: false,
            bump: 254,
            refund_obligation_usdc: 0,
            tracks_refund_obligation: true,
            is_seeded: true,
            _reserved: [0u8; 54],
        }
    }

    fn args(refund: u64, book_refund: u64) -> PublishResolutionCommitmentArgs {
        PublishResolutionCommitmentArgs {
            merkle_root: [9u8; 32],
            t_star: 500,
            leaf_count: 3,
            total_void_refund_usdc: refund,
            total_book_void_refund_usdc: book_refund,
        }
    }

    #[test]
    fn the_seed_inventory_is_not_an_obligation() {
        // Nobody holds the shares the subsidy bought, so counting them would
        // refuse commitments a solvent vault could cover.
        let a = amm(12 * WAD, 2 * WAD);
        assert_eq!(amm_ledger_obligations(&a, OUTCOME_YES).unwrap(), 10 * BASE);
        assert_eq!(amm_ledger_obligations(&a, OUTCOME_NO).unwrap(), 0);
    }

    #[test]
    fn a_commitment_the_vault_covers_is_published() {
        // 10 YES outstanding = 10 units owed, plus a 3-unit refund ceiling.
        let a = amm(12 * WAD, 2 * WAD);
        assert!(assert_commitment_fits_the_vaults(
            &a,
            13 * BASE,
            0,
            0,
            OUTCOME_YES,
            &args(3 * BASE, 0)
        )
        .is_ok());
    }

    #[test]
    fn a_commitment_the_vault_cannot_cover_is_refused() {
        // The regression for gap (3) of the design doc: the published total
        // used to EXPOSE this risk without bounding it.
        let a = amm(12 * WAD, 2 * WAD);
        assert!(assert_commitment_fits_the_vaults(
            &a,
            13 * BASE - 1,
            0,
            0,
            OUTCOME_YES,
            &args(3 * BASE, 0)
        )
        .is_err());
    }

    #[test]
    fn refusal_degrades_to_no_voiding_rather_than_to_frozen_funds() {
        // A commitment that does not fit is simply not published, and the
        // market then redeems exactly as it does today — the same safe
        // degradation as an adjudicator who never publishes at all.
        let a = amm(12 * WAD, 2 * WAD);
        assert!(
            assert_commitment_fits_the_vaults(&a, 10 * BASE, 0, 0, OUTCOME_YES, &args(0, 0))
                .is_ok()
        );
    }

    #[test]
    fn an_invalid_outcome_owes_half_of_both_sides() {
        // The INVALID split is the same rule redemption applies, so the bound
        // is computed against the payout that will actually be made.
        let a = amm(12 * WAD, 6 * WAD);
        assert_eq!(
            amm_ledger_obligations(&a, OUTCOME_INVALID).unwrap(),
            7 * BASE
        );
    }

    #[test]
    fn the_book_vault_is_bounded_separately_from_the_amm_vault() {
        // Two vaults, two mints, two ceilings. A shared bound would let one
        // venue's surplus vouch for the other's promise.
        let a = amm(2 * WAD, 2 * WAD);
        assert!(assert_commitment_fits_the_vaults(
            &a,
            u64::MAX / 2,
            5 * BASE,
            5 * BASE,
            OUTCOME_YES,
            &args(0, 1)
        )
        .is_err());
        assert!(assert_commitment_fits_the_vaults(
            &a,
            u64::MAX / 2,
            5 * BASE,
            6 * BASE,
            OUTCOME_YES,
            &args(0, BASE)
        )
        .is_ok());
    }

    #[test]
    fn a_market_with_no_book_may_not_claim_a_book_refund() {
        // An absent book account reads as zero obligations AND its vault
        // holds nothing, so any book refund at all fails the bound.
        let a = amm(2 * WAD, 2 * WAD);
        assert!(
            assert_commitment_fits_the_vaults(&a, BASE, 0, 0, OUTCOME_YES, &args(0, 1)).is_err()
        );
    }

    #[test]
    fn an_overflowing_ceiling_fails_rather_than_wraps() {
        let a = amm(12 * WAD, 2 * WAD);
        assert!(assert_commitment_fits_the_vaults(
            &a,
            u64::MAX,
            0,
            u64::MAX,
            OUTCOME_YES,
            &args(u64::MAX, 0)
        )
        .is_err());
    }
}
