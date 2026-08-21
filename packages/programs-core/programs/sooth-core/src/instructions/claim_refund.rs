//! `claim_refund` — refund a dismissed-market AMM Position.
//!
//! ## Why a refund can be short, and what is paid then
//!
//! Dismissal refunds at COST: every position is owed its
//! `Position.locked_cost_usdc`, and that pot is not self-funding. Writing
//! `net_i` for a position's buys minus its sell proceeds, the vault holds
//! `seed + Σ net_i` while refunds owe `Σ max(net_i, 0)` — a position that
//! exited at a profit floors at zero instead of going negative. The
//! difference is `seed − P`, where `P` is profit already withdrawn by traders
//! who round-tripped before the dismissal. When `P` exceeds the creator's
//! seed the vault cannot cover every refund.
//!
//! Paying each claim in full until the vault empties makes that a race, and
//! the loser is whoever claims last — someone who did nothing but hold. So
//! short vaults pay PRO-RATA: `locked_cost × vault ÷ obligation`, where the
//! obligation is `AmmState.refund_obligation_usdc`, the running sum of every
//! position's claim.
//!
//! The ratio is order-independent without snapshotting it. Paying `L·r` out
//! of `(V, O)` with `r = V/O` leaves `(V − L·r, O − L)`, whose ratio is
//! `(V − LV/O)/(O − L) = V/O = r` exactly. Every claimant therefore meets the
//! same `r` whenever they arrive, and the floor division's dust accrues to
//! whoever claims later — the opposite of a race's incentive.
//!
//! It is final rather than provisional because a dismissed market's vault has
//! no further inflows: buying is closed, and the seed is already in. There is
//! no later top-up for a second pass to distribute.
//!
//! ## Prevention was the alternative, and it costs more than it saves
//!
//! The shortfall could be designed away by refusing to pay out a profitable
//! round trip — but that is the AMM refusing to be an AMM, on every market,
//! to protect against a dismissal that usually never comes. Pro-rata prices
//! the rare case instead of taxing the common one.
//!
//! ## Legacy accounts
//!
//! `AmmState.refund_obligation_usdc` reads zero on every account written
//! before it existed, and zero is the over-paying direction. The denominator
//! is therefore `max(obligation, locked_cost)` — a market's obligation can
//! never be smaller than the one claim in front of us — and the payout is
//! capped at the vault balance. An untracked market degrades to the old
//! first-come-first-served behaviour, but the last claimant now receives the
//! remainder instead of a failed transfer.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::AMM_TOKEN_MINT;
use crate::constants::{
    POSITION_LOCKED_COST_USDC_OFFSET, POSITION_MARKET_OFFSET,
    POSITION_TOTAL_LEN as POSITION_MIN_LEN, POSITION_USER_OFFSET,
};

use crate::error::SoothCoreError;
use crate::events::RefundClaimed;
use crate::state::{AmmState, Market};

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// AMM state for this market. Must be dismissed.
    ///
    /// `mut` for exactly one write: the paid claim leaves
    /// `refund_obligation_usdc`.
    #[account(
        mut,
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        constraint = amm_state.market == market.key() @ SoothCoreError::AmmStateMarketMismatch,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// Vault authority signer-only PDA.
    /// CHECK: derived via seeds.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault_amm @ SoothCoreError::VaultAuthorityMismatch,
        // The vault ITSELF is pinned by `address` above, so a mint mismatch
        // here means the recorded vault holds the wrong token — a mint fault,
        // not a vault-identity one.
        constraint = market_vault.mint == AMM_TOKEN_MINT
            @ SoothCoreError::WrongBaseMint,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = amm_mint,
        token::authority = user,
    )]
    pub user_amm_ata: Box<Account<'info, TokenAccount>>,

    /// AMM Position account — closed by the inline `close_dismissed_position`.
    /// CHECK: validated in handler body.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    #[account(address = AMM_TOKEN_MINT)]
    pub amm_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
}

/// Refunds are the terminal alternative to settlement payouts.
///
/// Both draw on the same AMM vault, so a market that could do both would pay
/// one deposit twice. The market must therefore be dismissed and must not have
/// settled. `dismiss_market` refuses anything but an `Open` market and `settle`
/// refuses a dismissed one, so the two states are disjoint at the source; this
/// guard holds the exclusion independently of either.
///
/// Dismissal is read from `AmmState`, the account `dismiss_market` writes
/// first and the one every dismissed market carries, rather than from the
/// `Market` mirror.
fn assert_refundable(market: &Market, amm: &AmmState) -> Result<()> {
    require!(amm.is_dismissed, SoothCoreError::MarketNotDismissed);
    require!(!market.is_settled(), SoothCoreError::MarketAlreadySettled);
    Ok(())
}

/// What a claim is actually paid, given the pot behind it.
///
/// `obligation` is the market-wide sum of outstanding claims and `vault` what
/// is there to pay them with. Full cost when the vault covers the total;
/// pro-rata when it does not.
///
/// The denominator floors at `locked_cost` for two reasons that are really
/// one: it is arithmetically true — a total that includes this claim cannot
/// be below it — and it makes an untracked counter (zero on every account
/// predating the field) collapse to `min(locked_cost, vault)` rather than a
/// division by zero or an unpayable transfer.
pub(crate) fn refund_payout(locked_cost: u64, obligation: u64, vault: u64) -> u64 {
    if locked_cost == 0 {
        return 0;
    }
    let denominator = obligation.max(locked_cost);
    if vault >= denominator {
        return locked_cost;
    }
    // Widened: `locked_cost × vault` overflows u64 well inside real balances.
    // Floor division, so the sum of payouts can never exceed the vault.
    ((locked_cost as u128 * vault as u128) / denominator as u128) as u64
}

pub fn handler(ctx: Context<ClaimRefund>) -> Result<()> {
    let market_id = ctx.accounts.market.market_id;
    let market_key = ctx.accounts.market.key();
    let user_key = ctx.accounts.user.key();

    assert_refundable(&ctx.accounts.market, &ctx.accounts.amm_state)?;

    let locked_cost_usdc =
        read_and_validate_position(&ctx.accounts.position, &market_id, &market_key, &user_key)?;

    let payout = refund_payout(
        locked_cost_usdc,
        ctx.accounts.amm_state.refund_obligation_usdc,
        ctx.accounts.market_vault.amount,
    );

    // The claim is extinguished in full, not by what it was paid. A pro-rata
    // shortfall is the whole distribution, so a remainder left standing in
    // the total would be an obligation nothing can ever settle — and would
    // hold `reclaim_subsidy` shut on a market that has finished paying.
    ctx.accounts
        .amm_state
        .retire_refund_obligation(locked_cost_usdc);

    if payout > 0 {
        let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.user_amm_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
        )?;
    }

    // Spend the claim in place. The account stays: `LockEntry`'s seeds derive
    // from the position's key and `claim_unlocked` deserializes it, so a
    // position closed here would strand any sell proceeds still escrowed in
    // the lock vault. Zeroing the one field this instruction pays makes the
    // refund unrepeatable — the same trade `redeem_amm_position` makes, at
    // the cost of the account's rent.
    clear_locked_cost(&ctx.accounts.position)?;

    // The amount actually received, which under a shortfall is less than the
    // claim. Reporting the claim would tell an indexer money moved that did
    // not.
    emit!(RefundClaimed {
        market: market_key,
        user: user_key,
        amount_usdc: payout,
    });

    Ok(())
}

/// The refund a position is owed, read from the raw account buffer.
///
/// This is the one field `claim_refund` pays out, so it is also the field
/// `redeem_amm_position` clears when it pays a settlement claim — a position
/// cannot be owed both.
fn read_locked_cost(data: &[u8]) -> Result<u64> {
    Ok(u64::from_le_bytes(
        data[POSITION_LOCKED_COST_USDC_OFFSET..POSITION_LOCKED_COST_USDC_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(SoothCoreError::PositionMalformed))?,
    ))
}

fn read_and_validate_position(
    position: &UncheckedAccount,
    market_id: &[u8; 16],
    market_key: &Pubkey,
    user_key: &Pubkey,
) -> Result<u64> {
    // Each check reports the thing that actually failed. They are separate
    // variants rather than one because they fail for different reasons: a
    // wrong address is a caller bug, a wrong owner is an account substituted
    // from another program, a short buffer is a layout drift, and a user or
    // market mismatch is a position belonging to somebody or something else.
    let (expected_position, _) =
        Pubkey::find_program_address(&[b"pos", market_id.as_ref(), user_key.as_ref()], &crate::ID);
    require_keys_eq!(
        position.key(),
        expected_position,
        SoothCoreError::PositionAddressMismatch
    );
    require_keys_eq!(
        *position.to_account_info().owner,
        crate::ID,
        SoothCoreError::PositionOwnerMismatch
    );

    let data = position.try_borrow_data()?;
    require!(
        data.len() >= POSITION_MIN_LEN,
        SoothCoreError::PositionMalformed
    );
    let pos_user = Pubkey::new_from_array(
        data[POSITION_USER_OFFSET..POSITION_USER_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(SoothCoreError::PositionMalformed))?,
    );
    let pos_market = Pubkey::new_from_array(
        data[POSITION_MARKET_OFFSET..POSITION_MARKET_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(SoothCoreError::PositionMalformed))?,
    );
    let locked_cost_usdc = read_locked_cost(&data)?;
    drop(data);

    require_keys_eq!(pos_user, *user_key, SoothCoreError::PositionUserMismatch);
    require_keys_eq!(
        pos_market,
        *market_key,
        SoothCoreError::PositionMarketMismatch
    );
    Ok(locked_cost_usdc)
}

/// Zero the refund field in the raw buffer, leaving the rest of the position
/// intact. Writes through the same offset `read_locked_cost` reads, so the
/// two cannot disagree about which bytes hold the claim.
fn clear_locked_cost(position: &UncheckedAccount) -> Result<()> {
    let mut data = position.try_borrow_mut_data()?;
    let end = POSITION_LOCKED_COST_USDC_OFFSET + 8;
    require!(data.len() >= end, SoothCoreError::PositionMalformed);
    data[POSITION_LOCKED_COST_USDC_OFFSET..end].fill(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::amm_state::{amm_fixture, legacy_amm_fixture};
    use crate::state::market::market_fixture;
    use crate::state::MarketLifecycle;

    #[test]
    fn a_dismissed_market_refunds() {
        let mut market = market_fixture(MarketLifecycle::Open);
        let mut amm = amm_fixture();
        market.is_dismissed = true;
        amm.is_dismissed = true;
        assert!(assert_refundable(&market, &amm).is_ok());
    }

    #[test]
    fn a_live_market_does_not_refund() {
        let market = market_fixture(MarketLifecycle::Open);
        let amm = amm_fixture();
        assert!(assert_refundable(&market, &amm).is_err());
    }

    #[test]
    fn a_settled_market_never_refunds() {
        // The double-pay invariant from the other side: settle → redeem →
        // dismiss → claim_refund. `dismiss_market` refuses a settled market,
        // and a market carrying a dismissal flag still pays no refund once
        // settled — either guard alone is enough.
        let mut market = market_fixture(MarketLifecycle::Settled);
        let mut amm = amm_fixture();
        amm.is_dismissed = true;
        market.is_dismissed = true;
        assert!(assert_refundable(&market, &amm).is_err());
    }

    #[test]
    fn the_amm_flag_alone_is_enough_to_refund() {
        // Dismissal is read from `AmmState`, so an entry whose `Market` mirror
        // is clear still opens the exit.
        let market = market_fixture(MarketLifecycle::Open);
        let mut amm = amm_fixture();
        amm.is_dismissed = true;
        assert!(assert_refundable(&market, &amm).is_ok());
    }

    /// The raw buffer `claim_refund` reads: discriminator then Borsh fields.
    fn serialize_position(position: &crate::state::Position) -> Vec<u8> {
        use anchor_lang::{AnchorSerialize, Discriminator};
        let mut data = crate::state::Position::DISCRIMINATOR.to_vec();
        position.serialize(&mut data).unwrap();
        data
    }

    #[test]
    fn the_refund_read_lands_on_locked_cost_usdc() {
        // Pins the offset the raw parser uses against the real Borsh layout.
        let mut position = crate::state::position::position_fixture();
        position.yes_shares = 7;
        position.no_shares = 9;
        position.locked_cost_usdc = 1_250_000;
        let data = serialize_position(&position);
        assert_eq!(read_locked_cost(&data).unwrap(), 1_250_000);
    }

    #[test]
    fn a_refund_spends_the_claim_without_erasing_the_position() {
        // `LockEntry`'s seeds derive from the position's key and
        // `claim_unlocked` deserializes the position, so a refund that wiped
        // the account would leave escrowed sell proceeds unreachable for
        // good. The claim goes to zero; the shares and identity stay.
        let mut position = crate::state::position::position_fixture();
        position.yes_shares = 11;
        position.no_shares = 3;
        position.locked_cost_usdc = 900_000;
        let mut data = serialize_position(&position);

        let end = POSITION_LOCKED_COST_USDC_OFFSET + 8;
        data[POSITION_LOCKED_COST_USDC_OFFSET..end].fill(0);

        assert_eq!(
            read_locked_cost(&data).unwrap(),
            0,
            "refund is unrepeatable"
        );
        let after = crate::state::Position::try_deserialize(&mut data.as_slice())
            .expect("the position still deserializes, so claim_unlocked still works");
        assert_eq!(after.yes_shares, 11);
        assert_eq!(after.no_shares, 3);
        assert_eq!(after.user, position.user);
        assert_ne!(&data[..8], &[0u8; 8], "the discriminator survives");
    }

    #[test]
    fn a_covered_vault_refunds_every_claim_in_full() {
        // 3 000 000 owed against 5 000 000 held: nobody is short, so nobody is
        // scaled.
        assert_eq!(refund_payout(1_000_000, 3_000_000, 5_000_000), 1_000_000);
        assert_eq!(refund_payout(2_000_000, 3_000_000, 3_000_000), 2_000_000);
    }

    #[test]
    fn a_short_vault_pays_pro_rata_rather_than_first_come_first_served() {
        // The bug this replaces: 3 000 000 owed, 1 500 000 held. Paying at
        // cost, the first two claimants take everything and the third — who
        // did nothing but hold — cannot claim at all. Pro-rata pays each half.
        let (obligation, vault) = (3_000_000u64, 1_500_000u64);
        assert_eq!(refund_payout(1_000_000, obligation, vault), 500_000);
        assert_eq!(refund_payout(2_000_000, obligation, vault), 1_000_000);
    }

    #[test]
    fn the_pro_rata_share_does_not_depend_on_claim_order() {
        // The property that makes recomputing per claim equivalent to
        // snapshotting a ratio: paying L·r out of (V, O) leaves the ratio at
        // r exactly. Whoever arrives last meets the same fraction as whoever
        // arrived first, so the race is gone rather than reordered.
        let claims = [700_000u64, 1_300_000, 400_000, 2_600_000];
        let obligation: u64 = claims.iter().sum();
        let vault = obligation / 3;

        for start in 0..claims.len() {
            let (mut o, mut v) = (obligation, vault);
            let mut paid = vec![0u64; claims.len()];
            for step in 0..claims.len() {
                let i = (start + step) % claims.len();
                let p = refund_payout(claims[i], o, v);
                paid[i] = p;
                o = o.saturating_sub(claims[i]);
                v -= p;
            }
            for (i, claim) in claims.iter().enumerate() {
                // Floor division leaves at most one unit per claim.
                let fair = (*claim as u128 * vault as u128 / obligation as u128) as u64;
                assert!(
                    paid[i] >= fair.saturating_sub(1) && paid[i] <= fair + 1,
                    "order {start}: claim {i} paid {} vs fair {fair}",
                    paid[i]
                );
            }
            assert!(v <= claims.len() as u64, "the vault empties but for dust");
        }
    }

    #[test]
    fn the_payouts_never_exceed_the_vault() {
        // The property that makes every claim payable: the transfers sum to at
        // most what is there, so no claimant's transfer can fail for want of
        // balance.
        let claims = [1u64, 999_999, 3, 500_000, 7_777_777];
        let obligation: u64 = claims.iter().sum();
        for vault in [0u64, 1, 42, 1_000_000, obligation - 1, obligation] {
            let total: u64 = claims
                .iter()
                .map(|c| refund_payout(*c, obligation, vault))
                .sum();
            assert!(
                total <= vault,
                "vault {vault} would be overdrawn by {total}"
            );
        }
    }

    #[test]
    fn a_legacy_zero_counter_pays_at_cost_but_never_past_the_vault() {
        // Every AmmState written before the counter existed reads zero here
        // while real claims stand behind it — the over-paying direction. The
        // denominator floors at the claim in front of us, so an untracked
        // market degrades to the old first-come-first-served order instead of
        // dividing by zero, and the last claimant receives the remainder
        // rather than a failed transfer.
        assert_eq!(refund_payout(1_000_000, 0, 5_000_000), 1_000_000);
        assert_eq!(refund_payout(1_000_000, 0, 400_000), 400_000);
        assert_eq!(refund_payout(1_000_000, 0, 0), 0);
    }

    #[test]
    fn a_spent_claim_is_paid_nothing_whatever_the_vault_holds() {
        assert_eq!(refund_payout(0, 3_000_000, 9_000_000), 0);
    }

    #[test]
    fn the_obligation_counter_tracks_the_positions_in_any_order() {
        // The counter is only as good as the four sites that move it. This
        // drives the real helpers — the same calls the handlers make — through
        // mixed buy / sell / settle / refund sequences and checks the standing
        // invariant: refund_obligation_usdc == Σ locked_cost_usdc.
        use crate::instructions::redeem_amm_position::consume_position;
        use crate::instructions::sell_positions::claim_retired;
        use crate::state::market::OUTCOME_YES;

        #[derive(Clone, Copy)]
        enum Op {
            Buy(usize, u64),
            /// A sell whose vault outflow may exceed what the position still
            /// claims — that is the profitable round trip that empties the pot.
            Sell(usize, u64),
            Refund(usize),
            Settle(usize),
        }
        use Op::*;

        let scripts: [&[Op]; 4] = [
            &[Buy(0, 500), Buy(1, 300), Sell(0, 200), Refund(0), Refund(1)],
            &[Buy(0, 500), Refund(0), Buy(1, 300), Sell(1, 900), Refund(1)],
            &[
                Buy(0, 100),
                Buy(0, 250),
                Sell(0, 400),
                Buy(1, 90),
                Settle(1),
            ],
            &[
                Buy(1, 750),
                Sell(1, 1_000),
                Buy(0, 10),
                Refund(1),
                Settle(0),
            ],
        ];

        for script in scripts {
            let mut amm = amm_fixture();
            let mut positions = [
                crate::state::position::position_fixture(),
                crate::state::position::position_fixture(),
            ];
            for op in script {
                match *op {
                    Buy(i, cost) => {
                        positions[i].locked_cost_usdc += cost;
                        amm.accrue_refund_obligation(cost).unwrap();
                    }
                    Sell(i, outflow) => {
                        let retired = claim_retired(positions[i].locked_cost_usdc, outflow);
                        positions[i].locked_cost_usdc -= retired;
                        amm.retire_refund_obligation(retired);
                    }
                    Refund(i) => {
                        let claim = positions[i].locked_cost_usdc;
                        positions[i].locked_cost_usdc = 0;
                        amm.retire_refund_obligation(claim);
                    }
                    Settle(i) => {
                        let claim = consume_position(&mut positions[i], OUTCOME_YES).unwrap();
                        amm.retire_refund_obligation(claim.refund_cleared);
                    }
                }
                let sum: u64 = positions.iter().map(|p| p.locked_cost_usdc).sum();
                assert_eq!(
                    amm.refund_obligation_usdc, sum,
                    "counter drifted from the positions it mirrors"
                );
            }
        }
    }

    #[test]
    fn a_legacy_counter_cannot_be_driven_negative() {
        // An account that predates the counter carries positions it never
        // counted, so a sell or a settlement on it retires more than the total
        // holds. It clamps at zero instead of failing, which keeps those paths
        // working on markets already live.
        let mut amm = legacy_amm_fixture();
        amm.retire_refund_obligation(5_000_000);
        assert_eq!(amm.refund_obligation_usdc, 0);
        // And it starts counting from there rather than staying stuck.
        amm.accrue_refund_obligation(1_000).unwrap();
        assert_eq!(amm.refund_obligation_usdc, 1_000);
        assert!(
            !amm.tracks_refund_obligation,
            "a partial count is still not a total, and stays marked as such"
        );
    }

    #[test]
    fn a_position_already_paid_at_settlement_refunds_nothing() {
        // The P0 invariant at position level: whatever order the calls arrive
        // in, one deposit is paid once. This runs the real redemption path,
        // then reads the buffer exactly as `claim_refund` does.
        use crate::instructions::redeem_amm_position::consume_position;
        use crate::state::market::OUTCOME_YES;
        let mut position = crate::state::position::position_fixture();
        position.yes_shares = 2_000_000_000_000_000_000;
        position.locked_cost_usdc = 1_250_000;
        let claim = consume_position(&mut position, OUTCOME_YES).unwrap();
        assert!(claim.usdc_payout > 0, "the settlement claim was paid");
        let data = serialize_position(&position);
        assert_eq!(read_locked_cost(&data).unwrap(), 0);
    }
}
