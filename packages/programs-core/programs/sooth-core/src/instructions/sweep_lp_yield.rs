//! `sweep_lp_yield` — recover an LP-yield balance no LP token can claim.
//!
//! Its own module rather than a second handler inside `sweep_residual`: it
//! claims BOTH venues' yield vaults, and the venue-separation invariant is
//! asserted per source file (see `packages/sdk-solana/tests/venue-separation.test.ts`).
//! `redeem_lp` mixes venues for the same reason and is exempted the same way.
//!
//! ## The stranding
//!
//! `redeem_lp` is the only path out of the two per-market LP yield vaults,
//! and it divides by `lp_mint.supply`, so it needs a live supply and a holder
//! to burn. But LP tokens are ordinary SPL tokens: a holder can call the
//! token program's `burn` directly and destroy their claim without ever
//! touching `redeem_lp`. If the last holder does that, supply hits zero while
//! the vaults still hold everything `distribute_fees` paid in beforehand.
//!
//! That balance is then unreachable — and `close_market` requires every token
//! account at zero, so the market is also unclosable, its rent locked and its
//! vaults frozen. `distribute_fees_amm`/`_book` already fold the LP slice
//! into the protocol remainder once supply is zero, so this instruction is
//! only about what arrived BEFORE that: the two rules together mean the
//! vaults always drain.
//!
//! ## Why the treasury
//!
//! The claimants, ranked:
//!
//! - **Remaining LP holders** would be the right answer, but the precondition
//!   is that there are none: supply is zero, so no token exists to pay.
//! - **The LP holders who burned** destroyed their own claim by choosing a
//!   raw `burn` over `redeem_lp`. Nothing on chain records who they were —
//!   the position that would say is gone with the tokens — so paying them is
//!   not merely unfair, it is not expressible.
//! - **The creator** has a separate, capped claim (`reclaim_subsidy`, limited
//!   to what they posted) and this is not part of it. Routing fee revenue to
//!   the creator would also pay whoever induced the burn, and creator and LP
//!   are usually the same key here — turning a mistake into a payout.
//! - **The treasury** is what the protocol already does with an unclaimable
//!   LP slice: `distribute_fees_*` sends it there the moment supply is zero.
//!   Sweeping the earlier balance to the same place makes one rule out of
//!   two, rather than adding a second policy for the same money.
//!
//! ## Who may call
//!
//! Anyone, like `sweep_residual` and fee distribution: the destinations are
//! `token::authority = config.treasury`, pinned exactly as in
//! `distribute_fees`, so a cranker picks nothing. Gating it on an authority
//! would let one absent keeper hold a market's close hostage.
//!
//! ## Why a lifecycle gate is required
//!
//! Zero supply is not by itself terminal. `trade_positions` mints LP to the
//! BUYER on every pre-graduation trade, so an incubating market can go to
//! zero supply and back the moment somebody trades. Sweeping there would take
//! a vault the next LP was about to have a claim on.
//!
//! So this opens on exactly the condition `redeem_lp` opens on — graduated,
//! settled, or dismissed. Each one ends LP minting for good: `trade_positions`
//! mints only while `!graduated`, and a settled or dismissed market does not
//! trade at all. The two instructions therefore unlock together, and between
//! them the vaults always drain: a live supply redeems, a dead one sweeps.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothCoreError;
use crate::events::LpYieldSwept;
use crate::state::{AmmState, Market, ProtocolConfig};

/// Accounts for `sweep_lp_yield`. See the module docs for why the
/// treasury is the destination and why the gate is what it is.
#[derive(Accounts)]
pub struct SweepLpYield<'info> {
    #[account(seeds = [b"protocol_config"], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// Read for `is_graduated` / `is_dismissed` — half the gate that proves
    /// LP minting has stopped.
    #[account(
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        constraint = amm_state.market == market.key() @ SoothCoreError::AmmStateMarketMismatch,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// Read for its SUPPLY, which must be zero. Bound by seeds: an unbound
    /// mint would let a caller present any zero-supply mint and drain the
    /// vaults while real LP holders still had claims.
    #[account(
        seeds = [b"lp", market.market_id.as_ref()],
        bump,
    )]
    pub lp_mint: Box<Account<'info, Mint>>,

    /// CHECK: signer-only PDA; authority on both yield vaults.
    #[account(seeds = [b"lp_yield_authority"], bump)]
    pub lp_yield_authority: UncheckedAccount<'info>,

    #[account(address = crate::constants::AMM_TOKEN_MINT)]
    pub amm_mint: Box<Account<'info, Mint>>,

    #[account(address = crate::constants::BOOK_TOKEN_MINT)]
    pub book_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"lp_yield_amm", market.market_id.as_ref()],
        bump,
        token::authority = lp_yield_authority,
        token::mint = amm_mint,
    )]
    pub lp_yield_amm: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"lp_yield_book", market.market_id.as_ref()],
        bump,
        token::authority = lp_yield_authority,
        token::mint = book_mint,
    )]
    pub lp_yield_book: Box<Account<'info, TokenAccount>>,

    /// Treasury account for the AMM's token — owner pinned by config, the
    /// same binding `distribute_fees` uses. The cranker chooses nothing.
    #[account(
        mut,
        token::authority = config.treasury,
        token::mint = amm_mint,
    )]
    pub treasury_amm_vault: Box<Account<'info, TokenAccount>>,

    /// Treasury account for the book's token. Two accounts because one SPL
    /// account holds one mint, and the venues are denominated differently.
    #[account(
        mut,
        token::authority = config.treasury,
        token::mint = book_mint,
    )]
    pub treasury_book_vault: Box<Account<'info, TokenAccount>>,

    pub cranker: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

/// How much of each vault the sweep may take.
///
/// All of it, or nothing: once `lp_supply == 0` and no more LP can be minted
/// there is no fraction to reserve, because there is no holder to reserve it
/// for. Split out as a pure function so the gate is testable without a
/// validator.
pub(crate) fn lp_yield_sweepable(
    lp_minting_has_ended: bool,
    lp_supply: u64,
    amm_amount: u64,
    book_amount: u64,
) -> Result<u64> {
    // While the market still mints LP on every trade, a zero supply is a lull,
    // not an end. Same error `redeem_lp` uses for the same gate.
    require!(lp_minting_has_ended, SoothCoreError::NotGraduated);
    // A live supply means `redeem_lp` still works and every unit in these
    // vaults belongs to whoever holds the tokens. Refuse.
    require!(lp_supply == 0, SoothCoreError::LpSupplyNotZero);
    let total = amm_amount
        .checked_add(book_amount)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    require!(total > 0, SoothCoreError::NothingToDistribute);
    Ok(total)
}

pub fn handler(ctx: Context<SweepLpYield>) -> Result<()> {
    let amm_amount = ctx.accounts.lp_yield_amm.amount;
    let book_amount = ctx.accounts.lp_yield_book.amount;
    // `trade_positions` mints LP only while the market is ungraduated and
    // trading, so any of these three closes minting for good.
    let lp_minting_has_ended = ctx.accounts.amm_state.is_graduated
        || ctx.accounts.market.is_settled()
        || ctx.accounts.amm_state.is_dismissed;
    lp_yield_sweepable(
        lp_minting_has_ended,
        ctx.accounts.lp_mint.supply,
        amm_amount,
        book_amount,
    )?;

    let bump = ctx.bumps.lp_yield_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[b"lp_yield_authority", &[bump]]];
    for (vault, dest, amount) in [
        (
            ctx.accounts.lp_yield_amm.to_account_info(),
            ctx.accounts.treasury_amm_vault.to_account_info(),
            amm_amount,
        ),
        (
            ctx.accounts.lp_yield_book.to_account_info(),
            ctx.accounts.treasury_book_vault.to_account_info(),
            book_amount,
        ),
    ] {
        if amount == 0 {
            continue;
        }
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: vault,
                    to: dest,
                    authority: ctx.accounts.lp_yield_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    }

    emit!(LpYieldSwept {
        market: ctx.accounts.market.key(),
        market_id: ctx.accounts.market.market_id,
        amm_amount,
        book_amount,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_remainder_left_by_a_destroyed_supply_is_sweepable() {
        // The regression: a holder burned LP through the token program, so
        // supply is zero while the vaults still hold what `distribute_fees`
        // paid in earlier. Without a path out, `close_market`'s all-zero
        // requirement can never be met and the market never closes.
        assert_eq!(
            lp_yield_sweepable(true, 0, 700_000, 300_000).unwrap(),
            1_000_000
        );
    }

    #[test]
    fn one_venue_alone_is_enough_to_sweep() {
        // A market that never graduated has book yield of zero, and vice
        // versa. Either alone must still be recoverable.
        assert_eq!(lp_yield_sweepable(true, 0, 5, 0).unwrap(), 5);
        assert_eq!(lp_yield_sweepable(true, 0, 0, 5).unwrap(), 5);
    }

    #[test]
    fn a_live_lp_supply_keeps_its_own_yield() {
        // The guard that makes a permissionless sweep safe: while one LP
        // token exists, `redeem_lp` is the path and this instruction is theft.
        let err = lp_yield_sweepable(true, 1, 1_000_000, 0).unwrap_err();
        assert!(
            format!("{err:?}").contains("LpSupplyNotZero"),
            "a live supply must be refused by name, got {err:?}"
        );
    }

    #[test]
    fn an_incubating_market_cannot_be_swept_even_at_zero_supply() {
        // `trade_positions` mints LP to the buyer on every pre-graduation
        // trade, so zero supply here is a lull between holders, not the end of
        // the claim. Sweeping would take the next LP's yield before they
        // arrive.
        let err = lp_yield_sweepable(false, 0, 1_000_000, 0).unwrap_err();
        assert!(
            format!("{err:?}").contains("NotGraduated"),
            "a still-minting market must be refused by name, got {err:?}"
        );
    }

    #[test]
    fn empty_vaults_are_not_a_sweep() {
        // Nothing to move: fail rather than emit an event and charge a fee.
        assert!(lp_yield_sweepable(true, 0, 0, 0).is_err());
    }

    #[test]
    fn the_two_venues_cannot_overflow_the_total() {
        assert!(lp_yield_sweepable(true, 0, u64::MAX, 1).is_err());
    }
}
