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

use crate::error::SoothCoreError;
use crate::error_resolution::ResolutionError;
use crate::events::{ResolutionCommitmentPublished, ResolutionCommitmentRevoked};
use crate::state::resolution::{ResolutionCommitment, RESOLUTION_COMMITMENT_SEED};
use crate::state::{
    AdjudicatorEntry, Market, MarketLifecycle, ProtocolConfig, ADJUDICATOR_ENTRY_SEED,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct PublishResolutionCommitmentArgs {
    /// Root of the per-wallet entitlement tree.
    pub merkle_root: [u8; 32],
    /// The moment the market's event became public knowledge.
    pub t_star: i64,
    /// Leaves in the tree. Published so the tree's shape is reproducible.
    pub leaf_count: u32,
    /// Ceiling on the USDC the void path may pay out across every leaf.
    pub total_void_refund_usdc: u64,
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

pub fn publish_handler(
    ctx: Context<PublishResolutionCommitment>,
    args: PublishResolutionCommitmentArgs,
) -> Result<()> {
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

    let market_key = ctx.accounts.market.key();
    let publisher = ctx.accounts.authority.key();

    let commitment = &mut ctx.accounts.resolution_commitment;
    commitment.market = market_key;
    commitment.merkle_root = args.merkle_root;
    commitment.t_star = args.t_star;
    commitment.leaf_count = args.leaf_count;
    commitment.total_void_refund_usdc = args.total_void_refund_usdc;
    commitment.void_refund_paid_usdc = 0;
    commitment.publisher = publisher;
    commitment.published_at = now;
    commitment.bump = ctx.bumps.resolution_commitment;
    commitment._reserved = [0u8; 32];

    emit!(ResolutionCommitmentPublished {
        market: market_key,
        publisher,
        merkle_root: args.merkle_root,
        t_star: args.t_star,
        leaf_count: args.leaf_count,
        total_void_refund_usdc: args.total_void_refund_usdc,
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
            _reserved: [0; 2],
        }
    }

    fn args() -> PublishResolutionCommitmentArgs {
        PublishResolutionCommitmentArgs {
            merkle_root: [9u8; 32],
            t_star: 500,
            leaf_count: 3,
            total_void_refund_usdc: 1_000_000,
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
