//! `update_protocol_config` — the authority's setter over the live
//! `ProtocolConfig`, and the two-step authority handover beside it.
//!
//! ## Why this exists
//!
//! `initialize_protocol` wrote the singleton once and nothing could touch it
//! again. On the devnet deployment that left
//! `permissionless_adjudicators = false`, and because the UI's create flow
//! never calls `register_adjudicator`, markets reached their deadline with no
//! `AdjudicatorEntry` at all — no attestation, no settle, and every position,
//! LP stake and escrow inside them immobile. A config the operator cannot
//! change is not a safety property; it is a way to make one mistake
//! permanent.
//!
//! ## What is mutable, and what deliberately is not
//!
//! Every field here is a policy dial the deployment is expected to turn.
//! Nothing that decides WHO may turn them, or that has its own instruction
//! with its own event, is reachable from this call:
//!
//!   - **`permissionless_adjudicators`** — the field the bug is about.
//!   - **`treasury`** — a fee destination that stops working (a closed ATA, a
//!     rotated custody account) breaks `distribute_fees_*` for every market
//!     at once. Immobilising it would be the same class of bug again.
//!   - **`amm_fee_bps` / `book_fee_bps`** — rates, capped at
//!     [`MAX_UPDATABLE_FEE_BPS`] rather than at `MAX_FEE_BPS`. See that
//!     constant: a setter that can charge 100% is a way to take the next
//!     trade, not a way to price one.
//!   - **the four share bps** — these only route fees ALREADY collected
//!     between b-base, LPs, the adjudicator and the protocol. They still have
//!     to sum to 10 000, which the handler re-checks against the merged
//!     config rather than against the arguments, so a partial update that
//!     would leave the split inconsistent is rejected instead of stored.
//!   - **`graduation_bps`** — a threshold read at trade time; changing it
//!     moves a bar, never a balance.
//!   - **`default_trial_period`** — read only by `create_market`, so it
//!     cannot affect a market that already exists.
//!   - **`veto_period_secs`** — mutable, and the least obvious of the set. It
//!     is bounded on both sides (`0 < x <= MAX_VETO_PERIOD_SECS`), so neither
//!     direction can strand a settlement: too long is capped at 30 days, too
//!     short only shortens a guardian's reaction window on outcomes attested
//!     AFTER the change. A deployment that shipped a 1-second window by
//!     forgetting the argument has no other way back, and that is the failure
//!     this whole file exists to stop repeating.
//!
//! Refused:
//!
//!   - **`authority`** — handed over by [`transfer_authority`] +
//!     [`accept_authority`] instead, two steps and a separate instruction. It
//!     is the one field whose mis-set value cannot be fixed by a later call,
//!     so it does not ride along inside a multi-field update where a wrong
//!     byte is easy to miss.
//!   - **`paused`** — `pause` / `unpause` own it, and they emit
//!     `ProtocolPausedEvent`. A second path to the circuit-breaker would make
//!     the event log stop being the record of when trading halted.
//!   - **`bump`** — derived from the seeds; a stored bump that disagrees with
//!     them makes the singleton underivable.
//!   - **`pending_authority`** — written only by the handover pair, so a
//!     config update cannot quietly arm one.
//!
//! ## Shape of the arguments
//!
//! Every field is an `Option`, and `None` means "leave it". The alternative —
//! a full struct the caller must re-send — turns every one-field change into
//! a chance to clobber the other nine with a stale read.

use anchor_lang::prelude::*;

use crate::constants::MAX_VETO_PERIOD_SECS;
use crate::error::SoothCoreError;
use crate::events::{AuthorityTransferAccepted, AuthorityTransferStarted, ProtocolConfigUpdated};
use crate::state::protocol_config::{MAX_FEE_BPS, MAX_UPDATABLE_FEE_BPS};
use crate::state::ProtocolConfig;

/// Sparse update. `None` leaves a field exactly as it is.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct UpdateProtocolConfigArgs {
    pub permissionless_adjudicators: Option<bool>,
    pub treasury: Option<Pubkey>,
    pub amm_fee_bps: Option<u16>,
    pub book_fee_bps: Option<u16>,
    pub graduation_bps: Option<u16>,
    pub b_base_share_bps: Option<u16>,
    pub lp_yield_share_bps: Option<u16>,
    pub adjudicator_share_bps: Option<u16>,
    pub protocol_share_bps: Option<u16>,
    pub default_trial_period: Option<i64>,
    pub veto_period_secs: Option<i64>,
}

#[derive(Accounts)]
pub struct UpdateProtocolConfig<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = config.bump,
        constraint = config.authority == authority.key() @ SoothCoreError::Unauthorized,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    pub authority: Signer<'info>,
}

/// Apply the sparse update to a config value and validate the RESULT.
///
/// Separated from the handler so the rules are testable without a runtime,
/// and written as "merge then check" rather than "check then merge" for a
/// reason: the fee split is a constraint across four fields, and checking the
/// arguments alone would let a caller who updates one share against a stale
/// read of the other three store a split that does not sum to 10 000. Fees
/// would then round to something the vault cannot cover.
pub fn apply_update(cfg: &mut ProtocolConfig, args: &UpdateProtocolConfigArgs) -> Result<()> {
    if let Some(v) = args.permissionless_adjudicators {
        cfg.permissionless_adjudicators = v;
    }
    if let Some(v) = args.treasury {
        require!(v != Pubkey::default(), SoothCoreError::InvalidTreasury);
        cfg.treasury = v;
    }
    if let Some(v) = args.amm_fee_bps {
        require!(v <= MAX_UPDATABLE_FEE_BPS, SoothCoreError::FeeBpsOutOfRange);
        cfg.amm_fee_bps = v;
    }
    if let Some(v) = args.book_fee_bps {
        require!(v <= MAX_UPDATABLE_FEE_BPS, SoothCoreError::FeeBpsOutOfRange);
        cfg.book_fee_bps = v;
    }
    if let Some(v) = args.graduation_bps {
        // Zero reads as 10 000 downstream, so it is a legal value here: it is
        // what a config written before the field existed already says.
        require!(v <= MAX_FEE_BPS, SoothCoreError::FeeBpsOutOfRange);
        cfg.graduation_bps = v;
    }
    if let Some(v) = args.b_base_share_bps {
        cfg.b_base_share_bps = v;
    }
    if let Some(v) = args.lp_yield_share_bps {
        cfg.lp_yield_share_bps = v;
    }
    if let Some(v) = args.adjudicator_share_bps {
        cfg.adjudicator_share_bps = v;
    }
    if let Some(v) = args.protocol_share_bps {
        cfg.protocol_share_bps = v;
    }
    if let Some(v) = args.default_trial_period {
        require!(v > 0, SoothCoreError::InvalidTrialPeriod);
        cfg.default_trial_period = v;
    }
    if let Some(v) = args.veto_period_secs {
        // Same bounds `initialize_protocol` enforces, for the same reasons:
        // zero or negative makes `settle` callable before the attestation it
        // finalizes, and unbounded-large strands every redemption behind a
        // settle nobody can reach.
        require!(
            v > 0 && v <= MAX_VETO_PERIOD_SECS,
            SoothCoreError::InvalidVetoPeriod
        );
        cfg.veto_period_secs = v;
    }

    // The cross-field invariant, checked against the merged value.
    require!(
        cfg.split_total() == 10_000,
        SoothCoreError::FeeSplitMismatch
    );
    Ok(())
}

pub fn handler(ctx: Context<UpdateProtocolConfig>, args: UpdateProtocolConfigArgs) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    apply_update(cfg, &args)?;

    let now = Clock::get()?.unix_timestamp;
    emit!(ProtocolConfigUpdated {
        authority: ctx.accounts.authority.key(),
        treasury: cfg.treasury,
        amm_fee_bps: cfg.amm_fee_bps,
        book_fee_bps: cfg.book_fee_bps,
        graduation_bps: cfg.graduation_bps,
        b_base_share_bps: cfg.b_base_share_bps,
        lp_yield_share_bps: cfg.lp_yield_share_bps,
        adjudicator_share_bps: cfg.adjudicator_share_bps,
        protocol_share_bps: cfg.protocol_share_bps,
        default_trial_period: cfg.default_trial_period,
        veto_period_secs: cfg.veto_period_secs,
        permissionless_adjudicators: cfg.permissionless_adjudicators,
        ts: now,
    });
    Ok(())
}

// ── Authority handover ───────────────────────────────────────────────────

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = config.bump,
        constraint = config.authority == authority.key() @ SoothCoreError::Unauthorized,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    pub authority: Signer<'info>,
}

/// Nominate `new_authority`. Nothing changes hands until the nominee signs
/// [`accept_authority`].
///
/// Passing `Pubkey::default()` cancels a pending nomination, which is the
/// only way to withdraw one — and is why the default pubkey is not a legal
/// nominee.
pub fn transfer_handler(ctx: Context<TransferAuthority>, new_authority: Pubkey) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    cfg.pending_authority = new_authority;

    let now = Clock::get()?.unix_timestamp;
    emit!(AuthorityTransferStarted {
        authority: ctx.accounts.authority.key(),
        pending_authority: new_authority,
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    /// The nominee. Its signature is the whole point of the second step: it
    /// proves the key that is about to own the protocol exists and is
    /// controlled, which a one-step setter cannot establish.
    pub new_authority: Signer<'info>,
}

pub fn accept_handler(ctx: Context<AcceptAuthority>) -> Result<()> {
    let cfg = &mut ctx.accounts.config;

    // The default pubkey means "no nomination in flight". It is checked
    // separately from the key comparison so a config with no pending transfer
    // reports that, rather than `Unauthorized`, to whoever is confused.
    require_keys_neq!(
        cfg.pending_authority,
        Pubkey::default(),
        SoothCoreError::NoPendingAuthority
    );
    require_keys_eq!(
        ctx.accounts.new_authority.key(),
        cfg.pending_authority,
        SoothCoreError::Unauthorized
    );

    let previous = cfg.authority;
    cfg.authority = cfg.pending_authority;
    // One-shot: the nomination is spent, not left armed for a replay after a
    // later handover moves the seat somewhere else.
    cfg.pending_authority = Pubkey::default();

    let now = Clock::get()?.unix_timestamp;
    emit!(AuthorityTransferAccepted {
        previous_authority: previous,
        authority: cfg.authority,
        ts: now,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A config in the shape devnet's actually has: permissioned
    /// adjudicators, a 24h veto, a valid split.
    fn config_fixture() -> ProtocolConfig {
        ProtocolConfig {
            authority: Pubkey::new_unique(),
            treasury: Pubkey::new_unique(),
            amm_fee_bps: 100,
            book_fee_bps: 100,
            graduation_bps: 10_000,
            b_base_share_bps: 5_000,
            lp_yield_share_bps: 3_000,
            adjudicator_share_bps: 1_000,
            protocol_share_bps: 1_000,
            default_trial_period: 7 * 24 * 60 * 60,
            bump: 254,
            paused: false,
            permissionless_adjudicators: false,
            veto_period_secs: 24 * 60 * 60,
            pending_authority: Pubkey::default(),
            _reserved: [0; 28],
        }
    }

    #[test]
    fn the_flag_that_bricked_devnet_can_be_flipped() {
        // The whole point of the instruction.
        let mut cfg = config_fixture();
        assert!(!cfg.permissionless_adjudicators);
        apply_update(
            &mut cfg,
            &UpdateProtocolConfigArgs {
                permissionless_adjudicators: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(cfg.permissionless_adjudicators);
    }

    #[test]
    fn an_empty_update_changes_nothing_and_is_not_an_error() {
        let mut cfg = config_fixture();
        let before = (
            cfg.amm_fee_bps,
            cfg.treasury,
            cfg.veto_period_secs,
            cfg.permissionless_adjudicators,
        );
        apply_update(&mut cfg, &UpdateProtocolConfigArgs::default()).unwrap();
        assert_eq!(
            before,
            (
                cfg.amm_fee_bps,
                cfg.treasury,
                cfg.veto_period_secs,
                cfg.permissionless_adjudicators
            )
        );
    }

    #[test]
    fn none_leaves_a_field_alone_rather_than_zeroing_it() {
        // The failure a non-sparse setter has: updating one field with a
        // struct-shaped argument wipes the nine the caller did not fill in.
        let mut cfg = config_fixture();
        let treasury = cfg.treasury;
        apply_update(
            &mut cfg,
            &UpdateProtocolConfigArgs {
                amm_fee_bps: Some(42),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(cfg.amm_fee_bps, 42);
        assert_eq!(cfg.treasury, treasury);
        assert_eq!(cfg.book_fee_bps, 100);
    }

    #[test]
    fn the_setter_cannot_raise_a_taker_fee_to_a_rug() {
        // `initialize_protocol` accepts up to 10 000 bps; the setter must
        // not, because by the time it runs there is collateral to take.
        let mut cfg = config_fixture();
        for bad in [MAX_UPDATABLE_FEE_BPS + 1, 5_000, MAX_FEE_BPS] {
            assert!(apply_update(
                &mut cfg,
                &UpdateProtocolConfigArgs {
                    amm_fee_bps: Some(bad),
                    ..Default::default()
                }
            )
            .is_err());
            assert!(apply_update(
                &mut cfg,
                &UpdateProtocolConfigArgs {
                    book_fee_bps: Some(bad),
                    ..Default::default()
                }
            )
            .is_err());
        }
        assert_eq!(
            cfg.amm_fee_bps, 100,
            "a rejected update must not partially apply"
        );
    }

    #[test]
    fn the_cap_itself_is_reachable() {
        let mut cfg = config_fixture();
        apply_update(
            &mut cfg,
            &UpdateProtocolConfigArgs {
                amm_fee_bps: Some(MAX_UPDATABLE_FEE_BPS),
                book_fee_bps: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(cfg.amm_fee_bps, MAX_UPDATABLE_FEE_BPS);
        assert_eq!(cfg.book_fee_bps, 0);
    }

    #[test]
    fn a_partial_split_update_that_breaks_the_sum_is_refused() {
        // The reason the check runs on the MERGED config: moving one share
        // against a stale read of the other three would store a split that
        // does not add up, and fee distribution reads all four.
        let mut cfg = config_fixture();
        assert!(apply_update(
            &mut cfg,
            &UpdateProtocolConfigArgs {
                protocol_share_bps: Some(2_000),
                ..Default::default()
            }
        )
        .is_err());
    }

    #[test]
    fn a_consistent_split_update_lands() {
        let mut cfg = config_fixture();
        apply_update(
            &mut cfg,
            &UpdateProtocolConfigArgs {
                b_base_share_bps: Some(4_000),
                lp_yield_share_bps: Some(4_000),
                adjudicator_share_bps: Some(1_000),
                protocol_share_bps: Some(1_000),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(cfg.split_total(), 10_000);
        assert_eq!(cfg.lp_yield_share_bps, 4_000);
    }

    #[test]
    fn the_veto_window_keeps_both_of_its_bounds() {
        let mut cfg = config_fixture();
        for bad in [0, -1, MAX_VETO_PERIOD_SECS + 1] {
            assert!(apply_update(
                &mut cfg,
                &UpdateProtocolConfigArgs {
                    veto_period_secs: Some(bad),
                    ..Default::default()
                }
            )
            .is_err());
        }
        apply_update(
            &mut cfg,
            &UpdateProtocolConfigArgs {
                veto_period_secs: Some(MAX_VETO_PERIOD_SECS),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(cfg.veto_period_secs, MAX_VETO_PERIOD_SECS);
    }

    #[test]
    fn the_treasury_never_becomes_the_default_pubkey() {
        // Fees would be sent to an address nothing controls.
        let mut cfg = config_fixture();
        assert!(apply_update(
            &mut cfg,
            &UpdateProtocolConfigArgs {
                treasury: Some(Pubkey::default()),
                ..Default::default()
            }
        )
        .is_err());
    }

    #[test]
    fn a_trial_period_must_stay_positive() {
        let mut cfg = config_fixture();
        for bad in [0, -1] {
            assert!(apply_update(
                &mut cfg,
                &UpdateProtocolConfigArgs {
                    default_trial_period: Some(bad),
                    ..Default::default()
                }
            )
            .is_err());
        }
    }

    #[test]
    fn the_setter_reaches_no_field_that_decides_who_may_call_it() {
        // `authority`, `paused`, `bump` and `pending_authority` are absent
        // from the argument struct by construction; this pins that they are
        // also untouched by a maximal update.
        let mut cfg = config_fixture();
        let (authority, paused, bump, pending) =
            (cfg.authority, cfg.paused, cfg.bump, cfg.pending_authority);
        apply_update(
            &mut cfg,
            &UpdateProtocolConfigArgs {
                permissionless_adjudicators: Some(true),
                treasury: Some(Pubkey::new_unique()),
                amm_fee_bps: Some(50),
                book_fee_bps: Some(60),
                graduation_bps: Some(5_000),
                b_base_share_bps: Some(2_500),
                lp_yield_share_bps: Some(2_500),
                adjudicator_share_bps: Some(2_500),
                protocol_share_bps: Some(2_500),
                default_trial_period: Some(1_000),
                veto_period_secs: Some(3_600),
            },
        )
        .unwrap();
        assert_eq!(cfg.authority, authority);
        assert_eq!(cfg.paused, paused);
        assert_eq!(cfg.bump, bump);
        assert_eq!(cfg.pending_authority, pending);
    }

    #[test]
    fn a_config_written_before_pending_authority_existed_reads_as_unarmed() {
        // The field is carved from `_reserved`, which is zeroed on every
        // config already on chain. A live deployment must not come back with
        // an armed handover to some address nobody chose.
        let cfg = config_fixture();
        let mut bytes = Vec::new();
        AnchorSerialize::serialize(&cfg, &mut bytes).unwrap();
        let decoded = ProtocolConfig::deserialize(&mut bytes.as_slice()).unwrap();
        assert_eq!(decoded.pending_authority, Pubkey::default());
    }
}
