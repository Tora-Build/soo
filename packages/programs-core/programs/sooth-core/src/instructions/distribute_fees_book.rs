//! `distribute_fees_book` — drain a market's BOOK fee pool and split it.
//!
//! The AMM's counterpart is `distribute_fees_amm`. They are separate
//! instructions rather than one with a venue argument so that the pool's seed
//! and mint are fixed by the account struct: neither can be handed the other
//! venue's pool, which matters because the two hold different tokens and the
//! destinations are caller-supplied.
//!
//! ## Why this is not a copy of the AMM's split
//!
//! **There is no `b_base` slice here.** That share exists to grow the AMM's
//! LMSR liquidity, and `b` is denominated in the AMM's token. Routing
//! book-denominated fees into it would credit an AMM-token balance with book
//! tokens — the cross-currency mixing the whole split exists to prevent, and
//! the one mistake in this design that fails silently rather than loudly (see
//! `docs/design/dual-token-venues.md` §6.4).
//!
//! So the book's fees divide three ways — LP, adjudicator, protocol — and
//! `b_base_share_bps` is not read. `compute_book_fee_split` folds that slice
//! into the protocol remainder rather than dropping it, so the parts still sum
//! to the whole and no dust is stranded in the pool.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothCoreError;
use crate::events::MarketFeesDistributed;
use crate::state::{Market, ProtocolConfig};

#[derive(Accounts)]
pub struct DistributeFeesBook<'info> {
    #[account(
        seeds = [b"protocol_config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: signer-only PDA — authority on every per-market fee-pool token
    /// account.
    #[account(
        seeds = [b"fee_pool_authority"],
        bump,
    )]
    pub fee_pool_authority: UncheckedAccount<'info>,

    #[account(address = crate::constants::BOOK_TOKEN_MINT)]
    pub venue_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"fee_pool_book", market.market_id.as_ref()],
        bump,
        token::mint = venue_mint,
        token::authority = fee_pool_authority,
    )]
    pub fee_pool: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = venue_mint)]
    pub lp_yield_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = venue_mint)]
    pub adjudicator_fee_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = config.treasury, token::mint = venue_mint)]
    pub protocol_treasury_vault: Box<Account<'info, TokenAccount>>,

    pub cranker: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct BookFeeSplit {
    pub to_lp_yield: u64,
    pub to_adjudicator: u64,
    pub to_protocol: u64,
}

/// Three-way split. Floor division for the first two, remainder to protocol,
/// so the parts sum to the whole exactly.
///
/// `b_base_share_bps` is deliberately unread — see the module docs. Its share
/// lands in the protocol remainder rather than being dropped, because a pool
/// that does not fully drain accumulates dust nobody can claim.
pub(crate) fn compute_book_fee_split(
    total: u64,
    cfg: &ProtocolConfig,
) -> Result<BookFeeSplit> {
    let total_u128 = total as u128;
    let to_lp_yield: u64 = ((total_u128 * cfg.lp_yield_share_bps as u128) / 10_000)
        .try_into()
        .map_err(|_| error!(SoothCoreError::MathOverflow))?;
    let to_adjudicator: u64 = ((total_u128 * cfg.adjudicator_share_bps as u128) / 10_000)
        .try_into()
        .map_err(|_| error!(SoothCoreError::MathOverflow))?;
    let to_protocol: u64 = total
        .checked_sub(to_lp_yield)
        .and_then(|v| v.checked_sub(to_adjudicator))
        .ok_or(error!(SoothCoreError::MathOverflow))?;

    let sum = (to_lp_yield as u128)
        .checked_add(to_adjudicator as u128)
        .and_then(|v| v.checked_add(to_protocol as u128))
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    require!(sum == total_u128, SoothCoreError::FeeSplitMismatch);

    Ok(BookFeeSplit {
        to_lp_yield,
        to_adjudicator,
        to_protocol,
    })
}

pub fn handler(ctx: Context<DistributeFeesBook>) -> Result<()> {
    let total: u64 = ctx.accounts.fee_pool.amount;
    require!(total > 0, SoothCoreError::NothingToDistribute);

    let split = compute_book_fee_split(total, &ctx.accounts.config)?;

    let bump = ctx.bumps.fee_pool_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[b"fee_pool_authority", &[bump]]];

    for (to, amount) in [
        (ctx.accounts.lp_yield_vault.to_account_info(), split.to_lp_yield),
        (
            ctx.accounts.adjudicator_fee_vault.to_account_info(),
            split.to_adjudicator,
        ),
        (
            ctx.accounts.protocol_treasury_vault.to_account_info(),
            split.to_protocol,
        ),
    ] {
        if amount == 0 {
            continue;
        }
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.fee_pool.to_account_info(),
                    to,
                    authority: ctx.accounts.fee_pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    }

    emit!(MarketFeesDistributed {
        market: ctx.accounts.market.key(),
        market_id: ctx.accounts.market.market_id,
        total_usdc: total,
        // No `b_base` slice on this venue; the field stays for event-shape
        // parity with the AMM's distribution.
        to_b_base: 0,
        to_lp_yield: split.to_lp_yield,
        to_adjudicator: split.to_adjudicator,
        to_protocol: split.to_protocol,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(lp: u16, adj: u16) -> ProtocolConfig {
        ProtocolConfig {
            authority: Pubkey::default(),
            treasury: Pubkey::default(),
            amm_fee_bps: 500,
            book_fee_bps: 100,
            graduation_bps: 10_000,
            // Deliberately non-zero: the book split must IGNORE it, not
            // depend on it being unset.
            b_base_share_bps: 5_000,
            lp_yield_share_bps: lp,
            adjudicator_share_bps: adj,
            protocol_share_bps: 0,
            default_trial_period: 0,
            bump: 0,
            paused: false,
            permissionless_adjudicators: true,
            veto_period_secs: crate::constants::DEFAULT_VETO_PERIOD_SECS,
            _reserved: [0u8; 60],
        }
    }

    #[test]
    fn b_base_share_is_ignored_and_lands_with_the_protocol() {
        // The AMM's split would send 50% here to b_base. The book must not:
        // that slice grows AMM liquidity in the AMM's token, and this pool
        // holds the book's.
        let s = compute_book_fee_split(1_000_000, &cfg(3_000, 1_000)).unwrap();
        assert_eq!(s.to_lp_yield, 300_000);
        assert_eq!(s.to_adjudicator, 100_000);
        assert_eq!(s.to_protocol, 600_000, "b_base's share folds in here");
    }

    #[test]
    fn the_parts_always_sum_to_the_whole() {
        // A pool that does not fully drain leaves dust nobody can claim, and
        // the remainder-to-protocol rule is what prevents it.
        for total in [1u64, 3, 7, 999, 1_000_001, u32::MAX as u64] {
            let s = compute_book_fee_split(total, &cfg(3_333, 1_111)).unwrap();
            assert_eq!(
                s.to_lp_yield + s.to_adjudicator + s.to_protocol,
                total,
                "split did not sum for total={total}"
            );
        }
    }
}
