//! `redeem_amm_position` — pay out an AMM `Position` after settlement.
//!
//! ## Why this exists
//!
//! `trade_positions` credits `Position.yes_shares` / `no_shares` and takes the
//! user's USDC into the AMM vault; this instruction is the ONLY path that pays
//! a settled AMM position back out:
//!
//!   - `claim_refund` is gated on dismissal and on the market not having
//!     settled, so it does not apply to a market that settled normally.
//!     Settlement and dismissal exclude each other, and this instruction also
//!     clears the position's refund accounting — a deposit is paid once, on
//!     exactly one of the two paths.
//!   - `sell_positions` requires `market.is_open()`, so it stops working the
//!     moment the market locks.
//!
//! The payout rule mirrors the book's `redeem_book_seat` exactly — same
//! winning-side logic, same INVALID split, same floor conversion — so the two
//! ledgers pay out identically and neither can drift from the other.
//!
//! ## Why this does NOT close the Position account
//!
//! `claim_unlocked` requires the `Position` PDA to exist (it derives the
//! `LockEntry` seeds from `position.key()` and checks `position.bump`). A user
//! who sold before settlement has outstanding `LockEntry` accounts holding real
//! USDC; closing their `Position` here would strand that USDC.
//!
//! So the shares are zeroed and the account is left in place. That leaks the
//! Position's rent (~0.00083 SOL), which is the strictly safer trade. Reclaiming
//! it needs an outstanding-lock counter — cheap to add later, since `Position`
//! carries 32 reserved bytes.
//!
//! ## T\* voiding
//!
//! A market whose adjudicator published a `ResolutionCommitment` pays from a
//! per-wallet ENTITLEMENT — shares acquired at or before T\*, plus the cost of
//! everything acquired after it, refunded — instead of from the raw position.
//! The wallet carries a merkle proof; the program verifies it against the
//! published root. Mechanism and trust model: `docs/design/t-star-voiding.md`.
//!
//! Two properties hold that guard against every ordinary market:
//!
//!   - The commitment PDA is a REQUIRED account, pinned by seeds. A program
//!     cannot detect an account it was not handed, so an optional one — or a
//!     second "voided redeem" instruction beside an untouched original —
//!     would leave the full-payout path as a bypass for anyone who preferred it.
//!   - An uninitialised account at that address is the honest, overwhelmingly
//!     common state and means "no voiding": the handler then behaves exactly
//!     as it did before this path existed, and refuses a claim if one is
//!     supplied anyway.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::AMM_TOKEN_MINT;
use crate::error::SoothCoreError;
use crate::error_resolution::ResolutionError;
use crate::events::{Redeemed, VoidedRedeem};
use crate::math::wad_to_base;
use crate::merkle::{verify_proof, MAX_MERKLE_PROOF_LEN};
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::resolution::{voided_leaf, ResolutionCommitment, RESOLUTION_COMMITMENT_SEED};
use crate::state::{AmmState, Market, Position};

/// A wallet's entitlement under a published `ResolutionCommitment`, plus the
/// proof that it is in the tree.
///
/// The three values are the leaf preimage — they are not trusted, they are
/// HASHED, and the hash must be provably in the published root. What the
/// program additionally enforces (in `voided_claim_payout`) is that even a
/// leaf the resolver signed cannot pay more shares than the position holds or
/// more cash than it paid in. So a dishonest resolver can under-pay, which the
/// veto window catches, but cannot over-pay, which it could not.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct VoidedClaimArgs {
    /// YES shares acquired at or before T* and still held, in WAD.
    pub valid_yes_wad: u128,
    /// NO shares acquired at or before T* and still held, in WAD.
    pub valid_no_wad: u128,
    /// USDC paid for post-T* acquisitions, returned at cost.
    pub void_refund_usdc: u64,
    /// Sibling hashes from the leaf up to the root.
    pub proof: Vec<[u8; 32]>,
}

#[derive(Accounts)]
pub struct RedeemAmmPosition<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// Decremented as shares are redeemed, so `q_<side> - seed_q_<side>`
    /// always equals the winning shares still unclaimed. `sweep_residual`
    /// gates on that difference reaching zero — without this bookkeeping the
    /// vault's post-settlement surplus is indistinguishable from money still
    /// owed to a slow claimant, and could never be swept.
    #[account(
        mut,
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// CHECK: derived via seeds; signs the vault outflow.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Deliberately NOT `close = user` — see module docs.
    #[account(
        mut,
        seeds = [b"pos", market.market_id.as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = user @ SoothCoreError::Unauthorized,
        has_one = market @ SoothCoreError::Unauthorized,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        address = market.vault_amm @ SoothCoreError::VaultAuthorityMismatch,
        constraint = vault.mint == AMM_TOKEN_MINT
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault.mint, token::authority = user)]
    pub user_amm_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: raw because the honest state is that it DOES NOT EXIST — an
    /// `Account<'_, ResolutionCommitment>` would fail every ordinary market's
    /// redemption. The seeds pin the address, so an empty account here is
    /// proof of absence rather than an omission the caller chose; the handler
    /// checks the owner and discriminator before reading a live one.
    #[account(
        mut,
        seeds = [RESOLUTION_COMMITMENT_SEED, market.key().as_ref()],
        bump,
    )]
    pub resolution_commitment: UncheckedAccount<'info>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

/// What a settled position is owed, and the mutation that retires it.
pub(crate) struct SettlementClaim {
    pub yes_shares: i128,
    pub no_shares: i128,
    pub usdc_payout: u64,
    /// The `locked_cost_usdc` this call cleared. The caller owes the same
    /// decrement to `AmmState.refund_obligation_usdc`, which is the sum of
    /// that field across positions.
    pub refund_cleared: u64,
}

/// Pays a position exactly once, and retires its refund accounting with it.
///
/// Both legs are zeroed **and** `locked_cost_usdc` is cleared: that field is
/// the amount `claim_refund` pays, so leaving it standing would let a position
/// that has taken a settlement payout also be refunded out of the same vault.
/// Clearing it here makes the exclusion a property of the position itself,
/// independent of which lifecycle guard a future instruction remembers to
/// check. A repeat call is a no-op — the account survives settlement, so it IS
/// callable again.
/// The settlement rule, over whatever share counts it is handed: the winning
/// side pays 1:1 and INVALID splits. Shared by the ordinary path (which passes
/// the position's whole holding) and the voided path (which passes only the
/// pre-T* part), so the two cannot drift.
pub(crate) fn settled_payout(outcome: u8, yes_wad: u128, no_wad: u128) -> Result<u64> {
    let payout_wad = match outcome {
        OUTCOME_YES => yes_wad,
        OUTCOME_NO => no_wad,
        OUTCOME_INVALID => {
            yes_wad
                .checked_add(no_wad)
                .ok_or(error!(SoothCoreError::MathOverflow))?
                / 2
        }
        _ => return err!(SoothCoreError::InvalidOutcome),
    };
    wad_to_base(payout_wad)
}

pub(crate) fn consume_position(position: &mut Position, outcome: u8) -> Result<SettlementClaim> {
    // AMM shares are i128 because `trade_positions` and `sell_positions` do
    // signed arithmetic on them, but both assert `>= 0` after every mutation.
    // Re-check rather than trust it: a negative value reaching `wad_to_base`
    // would wrap on the cast.
    let yes_shares = position.yes_shares;
    let no_shares = position.no_shares;
    require!(
        yes_shares >= 0 && no_shares >= 0,
        SoothCoreError::InsufficientShares
    );

    let usdc_payout = settled_payout(outcome, yes_shares as u128, no_shares as u128)?;

    let refund_cleared = position.locked_cost_usdc;
    position.yes_shares = 0;
    position.no_shares = 0;
    position.locked_cost_usdc = 0;

    Ok(SettlementClaim {
        yes_shares,
        no_shares,
        usdc_payout,
        refund_cleared,
    })
}

/// Read the commitment PDA, or `None` if it does not exist.
///
/// Absence is the ordinary case and is NOT an error: the seeds already pinned
/// the address, so an empty account here means the adjudicator published
/// nothing, not that the caller withheld something. A live account is checked
/// for owner (so a look-alike buffer cannot be substituted), discriminator
/// (via `try_deserialize`), and market — the seeds bind the ADDRESS, this
/// binds the CONTENT, and a proof is only worth what the root it verifies
/// against belongs to.
fn load_commitment(
    info: &UncheckedAccount<'_>,
    market: Pubkey,
) -> Result<Option<ResolutionCommitment>> {
    let account = info.to_account_info();
    if account.data_is_empty() {
        return Ok(None);
    }
    require_keys_eq!(
        *account.owner,
        crate::ID,
        ResolutionError::CommitmentOwnerMismatch
    );
    let data = account.try_borrow_data()?;
    let commitment = ResolutionCommitment::try_deserialize(&mut &data[..])?;
    require_keys_eq!(
        commitment.market,
        market,
        ResolutionError::CommitmentMarketMismatch
    );
    Ok(Some(commitment))
}

/// Write the running void-refund total back. Done by hand because the account
/// is `UncheckedAccount` — Anchor only serializes accounts it deserialized.
fn store_commitment(info: &UncheckedAccount<'_>, commitment: &ResolutionCommitment) -> Result<()> {
    let account = info.to_account_info();
    let mut data = account.try_borrow_mut_data()?;
    let mut cursor: &mut [u8] = &mut data;
    commitment.try_serialize(&mut cursor)
}

/// The claim is in the published tree, and it is THIS wallet's claim.
///
/// Both facts come from the leaf preimage: `user` is inside it, so a proof
/// cannot be replayed by anyone else, and `market` is inside it, so a proof
/// from another market's tree cannot be presented here.
pub(crate) fn verify_voided_claim(
    commitment: &ResolutionCommitment,
    market: &Pubkey,
    user: &Pubkey,
    args: &VoidedClaimArgs,
) -> Result<()> {
    require!(
        args.proof.len() <= MAX_MERKLE_PROOF_LEN,
        ResolutionError::MerkleProofTooLong
    );
    let leaf = voided_leaf(
        market,
        user,
        args.valid_yes_wad,
        args.valid_no_wad,
        args.void_refund_usdc,
    );
    require!(
        verify_proof(leaf, &args.proof, commitment.merkle_root),
        ResolutionError::InvalidMerkleProof
    );
    Ok(())
}

/// What a voided position is paid: its pre-T* shares settled normally, plus
/// its post-T* cost returned.
///
/// The three bounds are what make a published tree safe to act on without
/// trusting it. Each is checked against state the position itself carries:
///
///   - `valid_*` cannot exceed the shares actually held, so the tree cannot
///     conjure shares — and in particular cannot pay a wallet for shares it
///     already sold.
///   - `void_refund_usdc` cannot exceed `locked_cost_usdc`, the same field
///     `claim_refund` pays from, so a refund can never exceed what this wallet
///     put in.
///
/// The aggregate ceiling (`total_void_refund_usdc`) is enforced by the caller,
/// on the commitment. Together they bound a dishonest resolver to UNDER-paying
/// — which the veto window exists to catch — rather than draining the vault.
pub(crate) fn voided_claim_payout(
    outcome: u8,
    args: &VoidedClaimArgs,
    claim: &SettlementClaim,
    locked_cost_usdc: u64,
) -> Result<u64> {
    require!(
        args.valid_yes_wad <= claim.yes_shares as u128,
        ResolutionError::EntitlementExceedsPosition
    );
    require!(
        args.valid_no_wad <= claim.no_shares as u128,
        ResolutionError::EntitlementExceedsPosition
    );
    require!(
        args.void_refund_usdc <= locked_cost_usdc,
        ResolutionError::VoidRefundExceedsCost
    );

    settled_payout(outcome, args.valid_yes_wad, args.valid_no_wad)?
        .checked_add(args.void_refund_usdc)
        .ok_or(error!(SoothCoreError::MathOverflow))
}

pub fn handler(
    ctx: Context<RedeemAmmPosition>,
    voided_claim: Option<VoidedClaimArgs>,
) -> Result<()> {
    require!(
        ctx.accounts.market.is_settled(),
        SoothCoreError::MarketNotSettled
    );

    // A dismissed market refunds at cost; it never pays a settlement claim.
    // Both flags are checked rather than one: `dismiss_market` writes them
    // together, and this instruction already loads both accounts, so neither
    // has to be trusted alone.
    require!(
        !ctx.accounts.market.is_dismissed && !ctx.accounts.amm_state.is_dismissed,
        SoothCoreError::MarketDismissed
    );

    let outcome = ctx.accounts.market.winning_outcome;
    let market_key = ctx.accounts.market.key();
    let user_key = ctx.accounts.user.key();

    // Read before `consume_position`, which clears it.
    let locked_cost_usdc = ctx.accounts.position.locked_cost_usdc;
    let mut commitment = load_commitment(&ctx.accounts.resolution_commitment, market_key)?;

    let claim = consume_position(&mut ctx.accounts.position, outcome)?;
    let (yes_shares_i, no_shares_i) = (claim.yes_shares, claim.no_shares);
    let (yes_shares, no_shares) = (yes_shares_i as u128, no_shares_i as u128);

    // Presence of a commitment and presence of a claim must agree. Neither
    // half is optional on its own: a claim without a commitment has no root to
    // verify against, and a commitment without a claim is the bypass the
    // account was added to close.
    let usdc_payout = match (commitment.as_mut(), voided_claim.as_ref()) {
        (None, None) => claim.usdc_payout,
        (None, Some(_)) => return err!(ResolutionError::UnexpectedVoidedClaim),
        (Some(_), None) => return err!(ResolutionError::VoidedClaimRequired),
        (Some(commitment), Some(args)) => {
            verify_voided_claim(commitment, &market_key, &user_key, args)?;
            let payout = voided_claim_payout(outcome, args, &claim, locked_cost_usdc)?;

            // The aggregate ceiling. Published before the veto window closed,
            // so an observer could compare it against the vault while there
            // was still time to revoke — per-leaf bounds alone would let a
            // tree that passes every individual check still empty the vault.
            let paid = commitment
                .void_refund_paid_usdc
                .checked_add(args.void_refund_usdc)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
            require!(
                paid <= commitment.total_void_refund_usdc,
                ResolutionError::VoidRefundExceedsPublishedTotal
            );
            commitment.void_refund_paid_usdc = paid;

            emit!(VoidedRedeem {
                market: market_key,
                user: user_key,
                valid_yes_wad: args.valid_yes_wad,
                valid_no_wad: args.valid_no_wad,
                void_refund_usdc: args.void_refund_usdc,
                held_yes_wad: yes_shares,
                held_no_wad: no_shares,
                ts: Clock::get()?.unix_timestamp,
            });

            payout
        }
    };

    if let Some(commitment) = commitment.as_ref() {
        store_commitment(&ctx.accounts.resolution_commitment, commitment)?;
    }

    // The cleared refund claim leaves the market-wide total with it. Settled
    // and dismissed markets exclude each other, so this total will never be
    // paid out here — but `refund_obligation_usdc == Σ locked_cost_usdc` is
    // the invariant that makes the number readable at all, and a ledger kept
    // only on the paths that read it is a ledger that drifts.
    // Saturating for the legacy case: an account that predates the counter
    // holds positions it never counted.
    ctx.accounts
        .amm_state
        .retire_refund_obligation(claim.refund_cleared);

    // Retire the redeemed shares from the outstanding count. `q = seed + Σ
    // positions` is the standing invariant, so an underflow here would mean a
    // position existed that q never counted — fail loud rather than mask it.
    let amm = &mut ctx.accounts.amm_state;
    amm.q_yes = amm
        .q_yes
        .checked_sub(yes_shares_i)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    amm.q_no = amm
        .q_no
        .checked_sub(no_shares_i)
        .ok_or(error!(SoothCoreError::MathOverflow))?;

    if usdc_payout > 0 {
        let market_id = ctx.accounts.market.market_id;
        let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_amm_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            usdc_payout,
        )?;
    }

    emit!(Redeemed {
        user: ctx.accounts.user.key(),
        market: ctx.accounts.market.key(),
        outcome,
        yes_burned: wad_to_base(yes_shares)?,
        no_burned: wad_to_base(no_shares)?,
        usdc_paid: usdc_payout,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::wad::WAD;
    use crate::merkle::{compute_proof, compute_root};
    use crate::state::position::position_fixture;

    /// A position holding both legs, with a cost on record — the shape every
    /// voiding assertion below needs.
    fn held(yes: i128, no: i128, cost: u64) -> (Position, SettlementClaim, u64) {
        let mut position = position_fixture();
        position.yes_shares = yes;
        position.no_shares = no;
        position.locked_cost_usdc = cost;
        let claim = consume_position(&mut position, OUTCOME_YES).unwrap();
        (position, claim, cost)
    }

    fn commitment(root: [u8; 32], market: Pubkey, total: u64) -> ResolutionCommitment {
        ResolutionCommitment {
            market,
            merkle_root: root,
            t_star: 500,
            leaf_count: 4,
            total_void_refund_usdc: total,
            void_refund_paid_usdc: 0,
            publisher: Pubkey::new_unique(),
            published_at: 600,
            bump: 254,
            total_book_void_refund_usdc: 0,
            book_void_refund_paid_usdc: 0,
            _reserved: [0u8; 16],
        }
    }

    fn args(yes: u128, no: u128, refund: u64, proof: Vec<[u8; 32]>) -> VoidedClaimArgs {
        VoidedClaimArgs {
            valid_yes_wad: yes,
            valid_no_wad: no,
            void_refund_usdc: refund,
            proof,
        }
    }

    #[test]
    fn the_winning_side_is_paid_and_the_losing_side_is_not() {
        let mut position = position_fixture();
        position.yes_shares = 3 * WAD;
        position.no_shares = 5 * WAD;
        let claim = consume_position(&mut position, OUTCOME_YES).unwrap();
        assert_eq!(claim.usdc_payout, wad_to_base(3 * WAD as u128).unwrap());
    }

    #[test]
    fn an_invalid_outcome_splits_both_legs() {
        let mut position = position_fixture();
        position.yes_shares = 3 * WAD;
        position.no_shares = 5 * WAD;
        let claim = consume_position(&mut position, OUTCOME_INVALID).unwrap();
        assert_eq!(claim.usdc_payout, wad_to_base(4 * WAD as u128).unwrap());
    }

    #[test]
    fn a_paid_position_carries_no_refund_claim() {
        // The P0 invariant: redeem → dismiss → claim_refund must not pay the
        // deposit a second time. `locked_cost_usdc` is what claim_refund pays.
        let mut position = position_fixture();
        position.yes_shares = 2 * WAD;
        position.locked_cost_usdc = 1_500_000;
        consume_position(&mut position, OUTCOME_YES).unwrap();
        assert_eq!(position.locked_cost_usdc, 0);
    }

    #[test]
    fn a_second_redeem_pays_nothing() {
        let mut position = position_fixture();
        position.yes_shares = 2 * WAD;
        position.locked_cost_usdc = 1_500_000;
        consume_position(&mut position, OUTCOME_YES).unwrap();
        let again = consume_position(&mut position, OUTCOME_YES).unwrap();
        assert_eq!(again.usdc_payout, 0);
        assert_eq!(again.yes_shares, 0);
        assert_eq!(again.no_shares, 0);
    }

    #[test]
    fn a_losing_position_still_gives_up_its_refund_claim() {
        // Payout is zero here, so only the cleared refund accounting stands
        // between this holder and being made whole after a later dismissal.
        let mut position = position_fixture();
        position.no_shares = 4 * WAD;
        position.locked_cost_usdc = 900_000;
        let claim = consume_position(&mut position, OUTCOME_YES).unwrap();
        assert_eq!(claim.usdc_payout, 0);
        assert_eq!(position.locked_cost_usdc, 0);
    }

    #[test]
    fn negative_shares_are_refused_rather_than_wrapped() {
        let mut position = position_fixture();
        position.yes_shares = -1;
        assert!(consume_position(&mut position, OUTCOME_YES).is_err());
        // The position is left untouched, so nothing is silently written off.
        assert_eq!(position.yes_shares, -1);
    }

    #[test]
    fn an_unknown_outcome_is_refused_before_anything_is_zeroed() {
        let mut position = position_fixture();
        position.yes_shares = WAD;
        position.locked_cost_usdc = 42;
        assert!(consume_position(&mut position, 7).is_err());
        assert_eq!(position.yes_shares, WAD);
        assert_eq!(position.locked_cost_usdc, 42);
    }

    // ── T* voiding ───────────────────────────────────────────────────────────

    #[test]
    fn a_voided_claim_settles_its_valid_shares_and_refunds_the_rest() {
        // The whole mechanism in one assertion: 10 YES held, only 4 of them
        // bought before T*, and 1.5 USDC paid for the 6 that came after.
        let (_, claim, cost) = held(10 * WAD, 0, 3_000_000);
        let a = args(4 * WAD as u128, 0, 1_500_000, vec![]);
        let payout = voided_claim_payout(OUTCOME_YES, &a, &claim, cost).unwrap();
        assert_eq!(payout, wad_to_base(4 * WAD as u128).unwrap() + 1_500_000);
        // Strictly less than the unvoided payout — that IS the voiding.
        assert!(payout < claim.usdc_payout + 1_500_000);
    }

    #[test]
    fn an_untouched_position_is_paid_the_same_either_way() {
        // A market where nothing needed voiding must pay exactly what it pays
        // today, or publishing a commitment would quietly change every payout.
        let (_, claim, cost) = held(7 * WAD, 2 * WAD, 4_000_000);
        let a = args(7 * WAD as u128, 2 * WAD as u128, 0, vec![]);
        assert_eq!(
            voided_claim_payout(OUTCOME_YES, &a, &claim, cost).unwrap(),
            claim.usdc_payout
        );
    }

    #[test]
    fn an_invalid_outcome_splits_only_the_valid_shares() {
        let (_, claim, cost) = held(10 * WAD, 10 * WAD, 5_000_000);
        let a = args(4 * WAD as u128, 2 * WAD as u128, 0, vec![]);
        let payout = voided_claim_payout(OUTCOME_INVALID, &a, &claim, cost).unwrap();
        assert_eq!(payout, wad_to_base(3 * WAD as u128).unwrap());
    }

    #[test]
    fn a_tree_cannot_pay_for_shares_the_position_never_held() {
        // The bound that keeps a dishonest resolver to under-paying: it can
        // sign any leaf it likes, but the position is the ceiling.
        let (_, claim, cost) = held(5 * WAD, 5 * WAD, 1_000_000);
        assert!(voided_claim_payout(
            OUTCOME_YES,
            &args(5 * WAD as u128 + 1, 0, 0, vec![]),
            &claim,
            cost
        )
        .is_err());
        assert!(voided_claim_payout(
            OUTCOME_YES,
            &args(0, 5 * WAD as u128 + 1, 0, vec![]),
            &claim,
            cost
        )
        .is_err());
    }

    #[test]
    fn a_tree_cannot_refund_more_than_the_position_paid_in() {
        // `locked_cost_usdc` is the same field `claim_refund` pays from, so
        // this bound is what stops a void refund becoming a second deposit.
        let (_, claim, cost) = held(0, 0, 900_000);
        assert!(
            voided_claim_payout(OUTCOME_YES, &args(0, 0, 900_000, vec![]), &claim, cost).is_ok()
        );
        assert!(
            voided_claim_payout(OUTCOME_YES, &args(0, 0, 900_001, vec![]), &claim, cost).is_err()
        );
    }

    #[test]
    fn an_already_redeemed_position_is_entitled_to_nothing() {
        // The account survives redemption, so this path IS reachable twice.
        // Both bounds collapse to zero, so a replayed proof pays nothing.
        let mut position = position_fixture();
        position.yes_shares = 3 * WAD;
        position.locked_cost_usdc = 1_000_000;
        consume_position(&mut position, OUTCOME_YES).unwrap();
        let second = consume_position(&mut position, OUTCOME_YES).unwrap();
        let a = args(3 * WAD as u128, 0, 1_000_000, vec![]);
        assert!(voided_claim_payout(OUTCOME_YES, &a, &second, 0).is_err());
        assert_eq!(
            voided_claim_payout(OUTCOME_YES, &args(0, 0, 0, vec![]), &second, 0).unwrap(),
            0
        );
    }

    #[test]
    fn a_wallets_own_proof_verifies_against_the_published_root() {
        let market = Pubkey::new_unique();
        let users: Vec<Pubkey> = (0..5).map(|_| Pubkey::new_unique()).collect();
        let leaves: Vec<[u8; 32]> = users
            .iter()
            .enumerate()
            .map(|(i, u)| voided_leaf(&market, u, i as u128 * WAD as u128, 0, i as u64))
            .collect();
        let root = compute_root(&leaves).unwrap();
        let c = commitment(root, market, 100);

        for (i, user) in users.iter().enumerate() {
            let proof = compute_proof(&leaves, i).unwrap();
            let a = args(i as u128 * WAD as u128, 0, i as u64, proof);
            verify_voided_claim(&c, &market, user, &a).unwrap();
        }
    }

    #[test]
    fn one_wallets_proof_does_not_pay_another_wallet() {
        // `user` is inside the leaf preimage, so a published proof is not a
        // bearer instrument.
        let market = Pubkey::new_unique();
        let users: Vec<Pubkey> = (0..4).map(|_| Pubkey::new_unique()).collect();
        let leaves: Vec<[u8; 32]> = users
            .iter()
            .map(|u| voided_leaf(&market, u, WAD as u128, 0, 1))
            .collect();
        let root = compute_root(&leaves).unwrap();
        let c = commitment(root, market, 100);
        let proof = compute_proof(&leaves, 1).unwrap();
        let a = args(WAD as u128, 0, 1, proof);

        verify_voided_claim(&c, &market, &users[1], &a).unwrap();
        assert!(verify_voided_claim(&c, &market, &users[2], &a).is_err());
    }

    #[test]
    fn a_proof_from_another_markets_tree_is_refused() {
        // `market` is inside the leaf as well as in the PDA seeds. Two markets
        // resolved by the same adjudicator would otherwise share leaf shapes.
        let mine = Pubkey::new_unique();
        let theirs = Pubkey::new_unique();
        let user = Pubkey::new_unique();
        let their_leaves: Vec<[u8; 32]> = (0..4)
            .map(|i| voided_leaf(&theirs, &user, i as u128, 0, 0))
            .collect();
        let their_root = compute_root(&their_leaves).unwrap();
        let c = commitment(their_root, theirs, 100);
        let proof = compute_proof(&their_leaves, 2).unwrap();
        let a = args(2, 0, 0, proof);

        verify_voided_claim(&c, &theirs, &user, &a).unwrap();
        assert!(verify_voided_claim(&c, &mine, &user, &a).is_err());
    }

    #[test]
    fn inflating_the_entitlement_invalidates_the_proof() {
        // Belt and braces with the position bound: even a wallet holding
        // plenty of shares cannot claim a bigger leaf than it was given.
        let market = Pubkey::new_unique();
        let user = Pubkey::new_unique();
        let leaves: Vec<[u8; 32]> = (0..4)
            .map(|i| voided_leaf(&market, &user, i as u128, 0, 5))
            .collect();
        let root = compute_root(&leaves).unwrap();
        let c = commitment(root, market, 100);
        let proof = compute_proof(&leaves, 1).unwrap();

        verify_voided_claim(&c, &market, &user, &args(1, 0, 5, proof.clone())).unwrap();
        assert!(verify_voided_claim(&c, &market, &user, &args(2, 0, 5, proof.clone())).is_err());
        assert!(verify_voided_claim(&c, &market, &user, &args(1, 1, 5, proof.clone())).is_err());
        assert!(verify_voided_claim(&c, &market, &user, &args(1, 0, 6, proof)).is_err());
    }

    #[test]
    fn an_over_long_proof_is_refused_before_it_is_walked() {
        let market = Pubkey::new_unique();
        let user = Pubkey::new_unique();
        let c = commitment([1u8; 32], market, 100);
        let a = args(0, 0, 0, vec![[0u8; 32]; MAX_MERKLE_PROOF_LEN + 1]);
        assert!(verify_voided_claim(&c, &market, &user, &a).is_err());
    }

    #[test]
    fn a_single_leaf_tree_needs_no_proof() {
        // Degenerate but real: a market where exactly one wallet traded after
        // T*. The root IS the leaf, and an empty proof is correct.
        let market = Pubkey::new_unique();
        let user = Pubkey::new_unique();
        let leaf = voided_leaf(&market, &user, 3, 0, 7);
        let c = commitment(leaf, market, 100);
        verify_voided_claim(&c, &market, &user, &args(3, 0, 7, vec![])).unwrap();
        assert!(verify_voided_claim(&c, &market, &user, &args(4, 0, 7, vec![])).is_err());
    }
}
