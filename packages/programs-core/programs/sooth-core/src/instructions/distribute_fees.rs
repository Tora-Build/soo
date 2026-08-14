//! `distribute_fees_amm` — drain a market's AMM fee pool and split it four
//! ways per architecture §8 / SoothBook §9.5.
//!
//! One instruction per venue rather than one with a venue argument. The pool's
//! seed and mint are then fixed by the account struct, so an instruction
//! cannot be handed the other venue's pool — which matters because the two
//! hold different tokens and the destinations are caller-supplied.
//!
//! The book's counterpart is `distribute_fees_book`. It is deliberately NOT a
//! copy with a different constant: the `b_base` share does not exist there.
//! That slice grows the AMM's liquidity, and feeding it book-denominated fees
//! is exactly the cross-currency mixing the token split exists to prevent —
//! see `docs/design/dual-token-venues.md` §6.4.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothCoreError;
use crate::events::MarketFeesDistributed;
use crate::state::{Market, ProtocolConfig};

#[derive(Accounts)]
pub struct DistributeFeesAmm<'info> {
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

    #[account(address = crate::constants::AMM_TOKEN_MINT)]
    pub venue_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"fee_pool_amm", market.market_id.as_ref()],
        bump,
        token::mint = venue_mint,
        token::authority = fee_pool_authority,
    )]
    pub fee_pool: Box<Account<'info, TokenAccount>>,

    // ── Destinations ─────────────────────────────────────────────────────
    //
    // Every one is pinned. They used to carry `token::mint` and nothing else,
    // while `cranker` is any signer — so anyone could call this and route the
    // b_base, LP and adjudicator shares (90% of the pool at the shipped split)
    // into accounts they controlled. Only the treasury was bound. It was
    // unreachable in practice because no client built the instruction, which
    // is not a security property.
    //
    /// The venue's own collateral vault: the `b_base` share stays with the
    /// market rather than leaving it.
    ///
    /// NOTE this deepens the vault; it does NOT raise `AmmState.b`. Growing
    /// `b` from fees is the EVM design's mechanism and is not implemented
    /// here, so the honest behaviour is to return the share to the collateral
    /// it came from. `reclaim_subsidy` cannot hand it to the creator — that is
    /// capped at what they actually posted.
    #[account(
        mut,
        address = market.vault_amm @ SoothCoreError::VaultAuthorityMismatch,
        token::mint = venue_mint,
    )]
    pub b_base_yield_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: signer-only PDA; authority on the LP yield vault.
    #[account(seeds = [b"lp_yield_authority"], bump)]
    pub lp_yield_authority: UncheckedAccount<'info>,

    /// The market's LP mint — read for its SUPPLY. Yield paid into the vault
    /// after the last LP has burned is unclaimable forever (`redeem_lp` needs
    /// a holder to exist), and it would block `close_market` forever too. So
    /// when supply is zero the LP slice folds into the protocol remainder
    /// instead: the last LP out forfeits nothing they were owed — the fees
    /// arriving now were earned after they exited.
    #[account(seeds = [b"lp", market.market_id.as_ref()], bump)]
    pub lp_mint: Box<Account<'info, Mint>>,

    /// THIS market's AMM-side yield vault — the same account `redeem_lp`
    /// pays LP holders from, so the share lands where the claim path expects
    /// it. Seeded by market_id: a global vault here was a cross-market theft,
    /// since redeem paid the whole pool out against one market's LP supply.
    #[account(
        mut,
        seeds = [b"lp_yield_amm", market.market_id.as_ref()],
        bump,
        token::authority = lp_yield_authority,
        token::mint = venue_mint,
    )]
    pub lp_yield_vault: Box<Account<'info, TokenAccount>>,

    /// The market's own adjudicator, from `Market`. Not a caller-supplied
    /// address.
    #[account(
        mut,
        token::authority = market.adjudicator,
        token::mint = venue_mint,
    )]
    pub adjudicator_fee_vault: Box<Account<'info, TokenAccount>>,

    /// `config.treasury` is the treasury's OWNER, not one token account.
    ///
    /// It was `address = config.treasury`, which cannot work once there are two
    /// venues: that pins one account, and the same account cannot also satisfy
    /// `token::mint = venue_mint` for two different mints. Whichever venue the
    /// treasury account did not hold could never distribute — its pool would
    /// fill and never drain. Binding the authority instead pins the
    /// destination just as tightly (the caller still cannot choose an owner)
    /// while letting the treasury hold one account per venue.
    #[account(
        mut,
        token::authority = config.treasury,
        token::mint = venue_mint,
    )]
    pub protocol_treasury_vault: Box<Account<'info, TokenAccount>>,

    pub cranker: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct FeeSplit {
    pub to_b_base: u64,
    pub to_lp_yield: u64,
    pub to_adjudicator: u64,
    pub to_protocol: u64,
}

/// Compute 4-way fee split. Floor division for first three slices, remainder
/// to protocol (no dust loss).
pub(crate) fn compute_fee_split(total: u64, cfg: &ProtocolConfig) -> Result<FeeSplit> {
    let b_base_bps = cfg.b_base_share_bps as u128;
    let lp_yield_bps = cfg.lp_yield_share_bps as u128;
    let adjudicator_bps = cfg.adjudicator_share_bps as u128;
    let total_u128 = total as u128;

    let to_b_base: u64 = ((total_u128 * b_base_bps) / 10_000)
        .try_into()
        .map_err(|_| error!(SoothCoreError::MathOverflow))?;
    let to_lp_yield: u64 = ((total_u128 * lp_yield_bps) / 10_000)
        .try_into()
        .map_err(|_| error!(SoothCoreError::MathOverflow))?;
    let to_adjudicator: u64 = ((total_u128 * adjudicator_bps) / 10_000)
        .try_into()
        .map_err(|_| error!(SoothCoreError::MathOverflow))?;
    let to_protocol: u64 = total
        .checked_sub(to_b_base)
        .and_then(|v| v.checked_sub(to_lp_yield))
        .and_then(|v| v.checked_sub(to_adjudicator))
        .ok_or(error!(SoothCoreError::MathOverflow))?;

    let split_sum = (to_b_base as u128)
        .checked_add(to_lp_yield as u128)
        .and_then(|v| v.checked_add(to_adjudicator as u128))
        .and_then(|v| v.checked_add(to_protocol as u128))
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    require!(split_sum == total_u128, SoothCoreError::FeeSplitMismatch);

    Ok(FeeSplit {
        to_b_base,
        to_lp_yield,
        to_adjudicator,
        to_protocol,
    })
}

pub fn handler(ctx: Context<DistributeFeesAmm>) -> Result<()> {
    let total: u64 = ctx.accounts.fee_pool.amount;
    require!(total > 0, SoothCoreError::NothingToDistribute);

    let mut split = compute_fee_split(total, &ctx.accounts.config)?;
    if ctx.accounts.lp_mint.supply == 0 {
        // No holder can ever claim this — see `lp_mint` above.
        split.to_protocol = split
            .to_protocol
            .checked_add(split.to_lp_yield)
            .ok_or(error!(SoothCoreError::MathOverflow))?;
        split.to_lp_yield = 0;
    }

    let bump = ctx.bumps.fee_pool_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[b"fee_pool_authority", &[bump]]];

    if split.to_b_base > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.fee_pool.to_account_info(),
                    to: ctx.accounts.b_base_yield_vault.to_account_info(),
                    authority: ctx.accounts.fee_pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            split.to_b_base,
        )?;
    }
    if split.to_lp_yield > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.fee_pool.to_account_info(),
                    to: ctx.accounts.lp_yield_vault.to_account_info(),
                    authority: ctx.accounts.fee_pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            split.to_lp_yield,
        )?;
    }
    if split.to_adjudicator > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.fee_pool.to_account_info(),
                    to: ctx.accounts.adjudicator_fee_vault.to_account_info(),
                    authority: ctx.accounts.fee_pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            split.to_adjudicator,
        )?;
    }
    if split.to_protocol > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.fee_pool.to_account_info(),
                    to: ctx.accounts.protocol_treasury_vault.to_account_info(),
                    authority: ctx.accounts.fee_pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            split.to_protocol,
        )?;
    }

    let now = Clock::get()?.unix_timestamp;
    emit!(MarketFeesDistributed {
        market: ctx.accounts.market.key(),
        market_id: ctx.accounts.market.market_id,
        total_usdc: total,
        to_b_base: split.to_b_base,
        to_lp_yield: split.to_lp_yield,
        to_adjudicator: split.to_adjudicator,
        to_protocol: split.to_protocol,
        ts: now,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from main's sooth_launchpad/tests/distribute_fees_per_market.rs.
    //
    // The on-chain drain path (pool emptied, only the addressed market's pool
    // touched) is already covered end-to-end by
    // apps/demo/e2e/onchain/orderbook-per-market-fee.spec.ts, so what is worth
    // restoring here is the split ARITHMETIC — a pure function, and the place
    // where a rounding mistake silently misroutes protocol revenue.

    fn cfg(b_base: u16, lp: u16, adj: u16, protocol: u16) -> ProtocolConfig {
        ProtocolConfig {
            authority: Pubkey::default(),
            treasury: Pubkey::default(),
            amm_fee_bps: 500,
            book_fee_bps: 100,
            graduation_bps: 10_000,
            b_base_share_bps: b_base,
            lp_yield_share_bps: lp,
            adjudicator_share_bps: adj,
            protocol_share_bps: protocol,
            default_trial_period: 0,
            bump: 0,
            paused: false,
            permissionless_adjudicators: true,
            veto_period_secs: crate::constants::DEFAULT_VETO_PERIOD_SECS,
            _reserved: [0u8; 60],
        }
    }

    /// Architecture §8 default, mirroring EVM FeeRouter: 50/30/10/10.
    fn default_cfg() -> ProtocolConfig {
        cfg(5_000, 3_000, 1_000, 1_000)
    }

    #[test]
    fn split_matches_the_documented_default_shares() {
        let s = compute_fee_split(1_000_000, &default_cfg()).unwrap();
        assert_eq!(s.to_b_base, 500_000);
        assert_eq!(s.to_lp_yield, 300_000);
        assert_eq!(s.to_adjudicator, 100_000);
        assert_eq!(s.to_protocol, 100_000);
    }

    #[test]
    fn split_always_sums_to_the_total() {
        // The property that actually matters: fees must never be created or
        // stranded. The three shares floor and protocol takes the remainder,
        // so the sum is exact for every input — including the awkward ones.
        for total in [
            1u64,
            2,
            3,
            7,
            9_999,
            10_001,
            123_456_789,
            u64::MAX / 10_000, // largest total that cannot overflow the bps mul
        ] {
            let s = compute_fee_split(total, &default_cfg()).unwrap();
            assert_eq!(
                s.to_b_base + s.to_lp_yield + s.to_adjudicator + s.to_protocol,
                total,
                "split does not sum for total={total}",
            );
        }
    }

    #[test]
    fn rounding_dust_goes_to_protocol_not_nowhere() {
        // total=1 with a 50/30/10/10 split floors the first three to zero, so
        // the whole unit must land on protocol. A naive fourth floor would
        // drop it and leave 1 base unit stuck in the pool forever.
        let s = compute_fee_split(1, &default_cfg()).unwrap();
        assert_eq!((s.to_b_base, s.to_lp_yield, s.to_adjudicator), (0, 0, 0));
        assert_eq!(s.to_protocol, 1);

        // 3 splits as 1/0/0/2 — protocol absorbs both remainders.
        let s = compute_fee_split(3, &default_cfg()).unwrap();
        assert_eq!(s.to_b_base, 1);
        assert_eq!(s.to_protocol, 2);
    }

    #[test]
    fn a_single_share_can_take_everything() {
        let s = compute_fee_split(1_000, &cfg(10_000, 0, 0, 0)).unwrap();
        assert_eq!(s.to_b_base, 1_000);
        assert_eq!(s.to_protocol, 0);

        let s = compute_fee_split(1_000, &cfg(0, 0, 0, 10_000)).unwrap();
        assert_eq!(s.to_b_base, 0);
        assert_eq!(s.to_protocol, 1_000);
    }

    #[test]
    fn protocol_share_bps_is_derived_not_trusted() {
        // to_protocol is computed as the REMAINDER, never from
        // protocol_share_bps. So a config whose bps do not sum to 10_000 still
        // distributes exactly `total` — the field is descriptive, and
        // initialize_protocol is what enforces the sum. Pinned so nobody
        // "fixes" this into a fourth floor division and reintroduces dust.
        let s = compute_fee_split(1_000, &cfg(5_000, 3_000, 1_000, 9_999)).unwrap();
        assert_eq!(
            s.to_b_base + s.to_lp_yield + s.to_adjudicator + s.to_protocol,
            1_000
        );
        assert_eq!(s.to_protocol, 100);
    }
}
