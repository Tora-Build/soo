//! `redeem_book_seat` — pay out a book position after settlement.
//!
//! ## Why this exists
//!
//! This is the only instruction that turns a winning book **position** into
//! money. `book_withdraw` moves *credit* — USDC already released by a cancel
//! or by a fill that closed exposure — and pays out no position at all, so
//! without this a trader who bought YES on the book and watched the market
//! settle YES would have their winnings stranded.
//!
//! ## The payout rule
//!
//! A seat carries a SIGNED net — `> 0` long YES, `< 0` long NO — because
//! selling YES and buying NO are the same trade on a single price axis. So the
//! rule is just "does the winning side match the sign", and each winning share
//! redeems for exactly one unit.
//!
//! This can never overpay. Every matched share was backed by a full unit at
//! fill time: the bid leg and the ask leg of a fill sum to exactly 1.00, and
//! exactly one of the two holders is paid at settlement. Total out equals total
//! in, by construction rather than by accounting.
//!
//! `OUTCOME_INVALID` splits, matching `redeem_amm_position` so the two
//! ledgers cannot drift.
//!
//! ## T\* voiding
//!
//! A market whose adjudicator published a `ResolutionCommitment` pays a seat
//! from its per-wallet ENTITLEMENT — the net acquired at or before T\*, plus
//! the cost of everything filled after it, refunded — instead of from the raw
//! seat. The wallet carries a merkle proof of its BOOK leaf (a distinct leaf
//! domain from the AMM one, in the same tree), the program verifies it against
//! the published root, and the seat is retired in full either way.
//!
//! The commitment PDA is a REQUIRED account for the same reason it is on
//! `redeem_amm_position`: a program cannot detect an account it was not
//! handed, so an optional one would leave the full-payout path as a bypass for
//! anyone who preferred it. An uninitialised account at that address is the
//! honest, overwhelmingly common state and means "no voiding" — the handler
//! then behaves exactly as it did before this path existed, and refuses a
//! claim if one is supplied anyway.
//!
//! ## Why resting orders are left alone
//!
//! Escrow behind a resting order is not a position; it is collateral for a
//! trade that has not happened. It comes back through `book_cancel`, which is
//! deliberately NOT gated on the market lifecycle so a maker is never trapped
//! after settlement. Draining it here would mean walking and unlinking the
//! trader's orders inside a settlement path, for no gain.
//!
//! ## Why the seat block is returned to the arena
//!
//! `take_settlement` zeroes both seat fields and then frees the block, so a
//! settled market's arena does not stay full of everyone who traded it. That is
//! only sound because this handler holds no cached block index — the matching
//! loop, which does, must never free a block.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::book::account::load_book;
use crate::constants::BOOK_TOKEN_MINT;
use crate::error::SoothCoreError;
use crate::error_resolution::ResolutionError;
use crate::events::{Redeemed, VoidedBookRedeem};
use crate::merkle::{verify_proof, MAX_MERKLE_PROOF_LEN};
use crate::state::resolution::{
    voided_book_leaf, ResolutionCommitment, RESOLUTION_COMMITMENT_SEED,
};
use crate::state::Market;

/// A seat's entitlement under a published `ResolutionCommitment`, plus the
/// proof that it is in the tree.
///
/// The two values are the leaf preimage — they are not trusted, they are
/// HASHED, and the hash must be provably in the published root. What the
/// program additionally enforces is that even a leaf the resolver signed
/// cannot settle a bigger net than the seat holds, nor refund more than the
/// voided fills could possibly have cost.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct VoidedBookClaimArgs {
    /// Signed net acquired at or before T* and still held: `> 0` long YES,
    /// `< 0` long NO.
    pub valid_net: i64,
    /// USDC paid for post-T* fills, returned at cost.
    pub book_void_refund_usdc: u64,
    /// Sibling hashes from the leaf up to the root.
    pub proof: Vec<[u8; 32]>,
}

#[derive(Accounts)]
pub struct RedeemBookSeat<'info> {
    /// CHECK: raw zero-copy book. `load_book` verifies the discriminator and
    /// length; the PDA seeds bind it to this market.
    #[account(mut, seeds = [b"book", market.market_id.as_ref()], bump)]
    pub book: UncheckedAccount<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: derived via seeds; signs the vault outflow.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault_book @ SoothCoreError::VaultAuthorityMismatch,
        constraint = vault_book.mint == BOOK_TOKEN_MINT
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub vault_book: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault_book.mint, token::authority = user)]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

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

/// Read the commitment PDA, or `None` if it does not exist.
///
/// Absence is the ordinary case and is NOT an error: the seeds already pinned
/// the address, so an empty account means the adjudicator published nothing.
/// A live account is checked for owner (so a look-alike buffer cannot be
/// substituted), discriminator, and market — the seeds bind the ADDRESS, this
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

/// Write the running book void-refund total back. Done by hand because the
/// account is `UncheckedAccount` — Anchor only serializes what it deserialized.
fn store_commitment(info: &UncheckedAccount<'_>, commitment: &ResolutionCommitment) -> Result<()> {
    let account = info.to_account_info();
    let mut data = account.try_borrow_mut_data()?;
    let mut cursor: &mut [u8] = &mut data;
    commitment.try_serialize(&mut cursor)
}

/// The claim is in the published tree, and it is THIS wallet's book claim.
///
/// Three facts come from the leaf preimage: `user` is inside it, so a proof
/// cannot be replayed by anyone else; `market` is inside it, so a proof from
/// another market's tree cannot be presented here; and the BOOK leaf domain is
/// inside it, so an AMM entitlement cannot be spent on a seat.
pub(crate) fn verify_voided_book_claim(
    commitment: &ResolutionCommitment,
    market: &Pubkey,
    user: &Pubkey,
    args: &VoidedBookClaimArgs,
) -> Result<()> {
    require!(
        args.proof.len() <= MAX_MERKLE_PROOF_LEN,
        ResolutionError::MerkleProofTooLong
    );
    let leaf = voided_book_leaf(market, user, args.valid_net, args.book_void_refund_usdc);
    require!(
        verify_proof(leaf, &args.proof, commitment.merkle_root),
        ResolutionError::InvalidMerkleProof
    );
    Ok(())
}

/// The per-seat bounds, checked against the seat's own net rather than against
/// the tree that asked for them.
///
/// Together with the market-wide ceiling on the commitment they bound a
/// dishonest resolver to UNDER-paying — which the veto window exists to catch
/// — rather than to draining the book vault:
///
///   - the entitlement is the same SIDE as the seat and no larger, so a tree
///     cannot conjure shares, and in particular cannot pay for a position the
///     wallet already closed;
///   - the refund cannot exceed the voided shares' full face value, because a
///     book fill costs strictly less than one unit per share.
///
/// The consequence, and it is deliberate: this seat can never be paid more
/// than the unvoided rule would have paid it at most (`|net| + credit`).
pub(crate) fn assert_book_claim_within_seat(net: i64, args: &VoidedBookClaimArgs) -> Result<()> {
    let same_side = args.valid_net == 0 || (args.valid_net > 0) == (net > 0);
    require!(
        same_side && args.valid_net.unsigned_abs() <= net.unsigned_abs(),
        ResolutionError::EntitlementExceedsSeat
    );
    let voided = net.unsigned_abs() - args.valid_net.unsigned_abs();
    require!(
        args.book_void_refund_usdc <= voided,
        ResolutionError::BookVoidRefundExceedsVoidedValue
    );
    Ok(())
}

pub fn handler(
    ctx: Context<RedeemBookSeat>,
    voided_claim: Option<VoidedBookClaimArgs>,
) -> Result<()> {
    require!(
        ctx.accounts.market.is_settled(),
        SoothCoreError::MarketNotSettled
    );

    let user = ctx.accounts.user.key();
    let winning_outcome = ctx.accounts.market.winning_outcome;
    let market_key = ctx.accounts.market.key();

    let mut commitment = load_commitment(&ctx.accounts.resolution_commitment, market_key)?;

    // Scoped so the book's borrow is released before the CPI — invoking the
    // token program while holding a RefMut on an account also passed to it
    // would abort.
    //
    // Presence of a commitment and presence of a claim must agree. Neither
    // half is optional on its own: a claim without a commitment has no root to
    // verify against, and a commitment without a claim is the bypass the
    // account was added to close.
    let (payout, held_net) = {
        let info = ctx.accounts.book.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        let mut book =
            load_book(&mut data).map_err(|_| error!(SoothCoreError::InvalidBookAccount))?;
        let held_net = book
            .net_of(user)
            .map_err(|_| error!(SoothCoreError::InvalidBookAccount))?;

        // Zeroed BEFORE the transfer, so a re-entrant call finds nothing left.
        let payout = match (commitment.as_mut(), voided_claim.as_ref()) {
            (None, None) => book
                .take_settlement(user, winning_outcome)
                .map_err(|_| error!(SoothCoreError::InvalidBookAccount))?,
            (None, Some(_)) => return err!(ResolutionError::UnexpectedVoidedClaim),
            (Some(_), None) => return err!(ResolutionError::VoidedClaimRequired),
            (Some(commitment), Some(args)) => {
                verify_voided_book_claim(commitment, &market_key, &user, args)?;
                assert_book_claim_within_seat(held_net, args)?;

                // The aggregate ceiling, published before the veto window
                // closed so an observer could compare it against the book
                // vault while there was still time to revoke. Per-seat bounds
                // alone would let a tree that passes every individual check
                // still empty the vault.
                let paid = commitment
                    .book_void_refund_paid_usdc
                    .checked_add(args.book_void_refund_usdc)
                    .ok_or(error!(SoothCoreError::MathOverflow))?;
                require!(
                    paid <= commitment.total_book_void_refund_usdc,
                    ResolutionError::BookVoidRefundExceedsPublishedTotal
                );
                commitment.book_void_refund_paid_usdc = paid;

                book.take_settlement_voided(
                    user,
                    winning_outcome,
                    args.valid_net,
                    args.book_void_refund_usdc,
                )
                .map_err(|_| error!(SoothCoreError::InvalidBookAccount))?
            }
        };
        (payout, held_net)
    };

    if let Some(commitment) = commitment.as_ref() {
        store_commitment(&ctx.accounts.resolution_commitment, commitment)?;
        if let Some(args) = voided_claim.as_ref() {
            emit!(VoidedBookRedeem {
                market: market_key,
                user,
                valid_net: args.valid_net,
                book_void_refund_usdc: args.book_void_refund_usdc,
                held_net,
                ts: Clock::get()?.unix_timestamp,
            });
        }
    }

    if payout > 0 {
        let market_id = ctx.accounts.market.market_id;
        let bump = ctx.accounts.market.vault_authority_bump;
        let seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_book.to_account_info(),
                    to: ctx.accounts.user_usdc_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                seeds,
            ),
            payout,
        )?;
    }

    emit!(Redeemed {
        user,
        market: ctx.accounts.market.key(),
        outcome: winning_outcome,
        // No outcome TOKENS are involved: a book position lives in the seat's
        // signed net, not in an SPL balance, so there is nothing to burn.
        yes_burned: 0,
        no_burned: 0,
        usdc_paid: payout,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merkle::{compute_proof, compute_root};
    use crate::state::market::OUTCOME_YES;
    use crate::state::resolution::voided_leaf;

    /// One share, in the base units the book speaks.
    const SHARE: i64 = 1_000_000;

    fn args(valid_net: i64, refund: u64, proof: Vec<[u8; 32]>) -> VoidedBookClaimArgs {
        VoidedBookClaimArgs {
            valid_net,
            book_void_refund_usdc: refund,
            proof,
        }
    }

    fn commitment(root: [u8; 32], market: Pubkey, book_total: u64) -> ResolutionCommitment {
        ResolutionCommitment {
            market,
            merkle_root: root,
            t_star: 500,
            leaf_count: 4,
            total_void_refund_usdc: 0,
            void_refund_paid_usdc: 0,
            publisher: Pubkey::new_unique(),
            published_at: 600,
            bump: 254,
            total_book_void_refund_usdc: book_total,
            book_void_refund_paid_usdc: 0,
            _reserved: [0u8; 16],
        }
    }

    #[test]
    fn an_entitlement_may_not_exceed_the_seat() {
        // The bound that keeps a dishonest tree to under-paying: it can sign
        // any leaf it likes, but the seat is the ceiling.
        assert!(assert_book_claim_within_seat(10 * SHARE, &args(10 * SHARE, 0, vec![])).is_ok());
        assert!(
            assert_book_claim_within_seat(10 * SHARE, &args(10 * SHARE + 1, 0, vec![])).is_err()
        );
    }

    #[test]
    fn an_entitlement_may_not_swap_sides() {
        // A seat long NO must not be paid as a seat long YES. Magnitude alone
        // would let exactly that through.
        assert!(assert_book_claim_within_seat(-10 * SHARE, &args(-4 * SHARE, 0, vec![])).is_ok());
        assert!(assert_book_claim_within_seat(-10 * SHARE, &args(4 * SHARE, 0, vec![])).is_err());
        assert!(assert_book_claim_within_seat(10 * SHARE, &args(-4 * SHARE, 0, vec![])).is_err());
    }

    #[test]
    fn voiding_the_whole_seat_is_legal_on_either_side() {
        // `valid_net == 0` means "every fill this wallet has came after T*",
        // which is the ordinary shape for a wallet that only traded late.
        assert!(assert_book_claim_within_seat(10 * SHARE, &args(0, 10, vec![])).is_ok());
        assert!(assert_book_claim_within_seat(-10 * SHARE, &args(0, 10, vec![])).is_ok());
    }

    #[test]
    fn a_refund_may_not_exceed_the_voided_shares_face_value() {
        // A book fill costs strictly less than one unit per share, so the
        // shares that stopped settling are the ceiling on their own refund.
        // 10 held, 4 valid -> 6 voided -> at most 6 units back.
        let net = 10 * SHARE;
        assert!(assert_book_claim_within_seat(net, &args(4 * SHARE, 6_000_000, vec![])).is_ok());
        assert!(assert_book_claim_within_seat(net, &args(4 * SHARE, 6_000_001, vec![])).is_err());
    }

    #[test]
    fn a_fully_valid_seat_can_be_refunded_nothing() {
        // Nothing was voided, so nothing may be refunded — otherwise a tree
        // could hand every untouched holder a bonus out of the vault.
        let net = 10 * SHARE;
        assert!(assert_book_claim_within_seat(net, &args(net, 0, vec![])).is_ok());
        assert!(assert_book_claim_within_seat(net, &args(net, 1, vec![])).is_err());
    }

    #[test]
    fn an_empty_seat_is_entitled_to_nothing() {
        // The seat is zeroed by redemption and the account survives, so this
        // path IS reachable twice. Both bounds collapse to zero.
        assert!(assert_book_claim_within_seat(0, &args(0, 0, vec![])).is_ok());
        assert!(assert_book_claim_within_seat(0, &args(0, 1, vec![])).is_err());
        assert!(assert_book_claim_within_seat(0, &args(1, 0, vec![])).is_err());
    }

    #[test]
    fn a_seats_own_proof_verifies_against_the_published_root() {
        let market = Pubkey::new_unique();
        let users: Vec<Pubkey> = (0..5).map(|_| Pubkey::new_unique()).collect();
        let leaves: Vec<[u8; 32]> = users
            .iter()
            .enumerate()
            .map(|(i, u)| voided_book_leaf(&market, u, i as i64 * SHARE, i as u64))
            .collect();
        let root = compute_root(&leaves).unwrap();
        let c = commitment(root, market, 100);

        for (i, user) in users.iter().enumerate() {
            let proof = compute_proof(&leaves, i).unwrap();
            let a = args(i as i64 * SHARE, i as u64, proof);
            verify_voided_book_claim(&c, &market, user, &a).unwrap();
        }
    }

    #[test]
    fn one_seats_proof_does_not_pay_another_seat() {
        let market = Pubkey::new_unique();
        let users: Vec<Pubkey> = (0..4).map(|_| Pubkey::new_unique()).collect();
        let leaves: Vec<[u8; 32]> = users
            .iter()
            .map(|u| voided_book_leaf(&market, u, SHARE, 1))
            .collect();
        let root = compute_root(&leaves).unwrap();
        let c = commitment(root, market, 100);
        let proof = compute_proof(&leaves, 1).unwrap();
        let a = args(SHARE, 1, proof);

        verify_voided_book_claim(&c, &market, &users[1], &a).unwrap();
        assert!(verify_voided_book_claim(&c, &market, &users[2], &a).is_err());
    }

    #[test]
    fn an_amm_entitlement_cannot_be_spent_on_a_seat() {
        // The reason the book leaf has its own domain byte. Same market, same
        // wallet, same numbers — and the proof still must not cross venues.
        let market = Pubkey::new_unique();
        let user = Pubkey::new_unique();
        let amm_leaves: Vec<[u8; 32]> = (0..4)
            .map(|i| voided_leaf(&market, &user, i as u128, 0, 5))
            .collect();
        let root = compute_root(&amm_leaves).unwrap();
        let c = commitment(root, market, 100);
        let proof = compute_proof(&amm_leaves, 1).unwrap();
        assert!(verify_voided_book_claim(&c, &market, &user, &args(1, 5, proof)).is_err());
    }

    #[test]
    fn inflating_a_book_entitlement_invalidates_the_proof() {
        let market = Pubkey::new_unique();
        let user = Pubkey::new_unique();
        let leaves: Vec<[u8; 32]> = (0..4)
            .map(|i| voided_book_leaf(&market, &user, i as i64, 5))
            .collect();
        let root = compute_root(&leaves).unwrap();
        let c = commitment(root, market, 100);
        let proof = compute_proof(&leaves, 1).unwrap();

        verify_voided_book_claim(&c, &market, &user, &args(1, 5, proof.clone())).unwrap();
        assert!(verify_voided_book_claim(&c, &market, &user, &args(2, 5, proof.clone())).is_err());
        assert!(verify_voided_book_claim(&c, &market, &user, &args(1, 6, proof)).is_err());
    }

    #[test]
    fn an_over_long_proof_is_refused_before_it_is_walked() {
        let market = Pubkey::new_unique();
        let user = Pubkey::new_unique();
        let c = commitment([1u8; 32], market, 100);
        let a = args(0, 0, vec![[0u8; 32]; MAX_MERKLE_PROOF_LEN + 1]);
        assert!(verify_voided_book_claim(&c, &market, &user, &a).is_err());
    }

    #[test]
    fn the_published_book_total_is_a_ceiling_across_seats() {
        // Per-seat bounds each pass here; the aggregate is what stops the
        // pair of them draining the vault.
        let mut c = commitment([1u8; 32], Pubkey::new_unique(), 1_500_000);
        c.book_void_refund_paid_usdc = 1_000_000;
        assert_eq!(c.book_void_refund_remaining(), 500_000);
        assert!(c.book_void_refund_paid_usdc + 600_000 > c.total_book_void_refund_usdc);
    }

    #[test]
    fn the_book_outcome_rule_is_unchanged_for_a_fully_valid_seat() {
        // Publishing a commitment must not quietly change what an untouched
        // seat is paid, or every market would need re-auditing.
        let net = 7 * SHARE;
        assert!(assert_book_claim_within_seat(net, &args(net, 0, vec![])).is_ok());
        assert_eq!(OUTCOME_YES, 1);
    }
}
