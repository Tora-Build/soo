//! `distribute_fees` — drain one market's fee-pool USDC vault and split the
//! proceeds across the four destinations per architecture §8 / SoothBook §9.5.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothCoreError;
use crate::events::MarketFeesDistributed;
use crate::state::{Market, ProtocolConfig};

#[derive(Accounts)]
pub struct DistributeFees<'info> {
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

    #[account(address = crate::constants::BASE_TOKEN_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"market_fee_pool", market.market_id.as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = fee_pool_authority,
    )]
    pub market_fee_pool: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = usdc_mint)]
    pub b_base_yield_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = usdc_mint)]
    pub lp_yield_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = usdc_mint)]
    pub adjudicator_fee_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = config.treasury, token::mint = usdc_mint)]
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

pub fn handler(ctx: Context<DistributeFees>) -> Result<()> {
    let total: u64 = ctx.accounts.market_fee_pool.amount;
    require!(total > 0, SoothCoreError::NothingToDistribute);

    let split = compute_fee_split(total, &ctx.accounts.config)?;

    let bump = ctx.bumps.fee_pool_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[b"fee_pool_authority", &[bump]]];

    if split.to_b_base > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_fee_pool.to_account_info(),
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
                    from: ctx.accounts.market_fee_pool.to_account_info(),
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
                    from: ctx.accounts.market_fee_pool.to_account_info(),
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
                    from: ctx.accounts.market_fee_pool.to_account_info(),
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
            fee_bps: 100,
            b_base_share_bps: b_base,
            lp_yield_share_bps: lp,
            adjudicator_share_bps: adj,
            protocol_share_bps: protocol,
            default_trial_period: 0,
            bump: 0,
            paused: false,
            permissionless_adjudicators: true,
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
