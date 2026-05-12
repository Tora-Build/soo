//! `distribute_fees` — drain one market's fee-pool USDC vault and split the
//! proceeds across the four destinations per architecture §8 / SoothBook §9.5.
//!
//! EVM analogue: `FeeRouter._distributePostGrad` (`FeeRouter.sol:377-413`).
//! On Solana this is **inlined inside `sooth_launchpad`** rather than a
//! separate program — see the §1 / §8 rationale in `lib.rs`.
//!
//! ## Design choice: split-at-distribute, not split-at-trade
//!
//! Two shapes were considered (see Wave 1C handover note):
//!
//!   1. **Split-at-trade.** `trade_positions` would transfer the four fee
//!      slices to four separate ATAs in one tx. Rejected because (a) it
//!      bloats `trade_positions`'s account list by four ATAs every trade,
//!      (b) it forces the dust-rounding rule into `trade_positions` where
//!      `wad_to_usdc_ceil` already handles user-side rounding.
//!
//!   2. **Pool-then-distribute** (chosen). `trade_positions` / sell-path fee
//!      routing transfer fee USDC into a per-market `market_fee_pool`
//!      TokenAccount owned by `fee_pool_authority`, a `sooth_launchpad` PDA.
//!      `distribute_fees` is a permissionless crank that drains one market's
//!      pool across the four destinations using PDA-signed CPIs. Mirrors
//!      EVM's `protocolAccrued`/`adjudicatorAccrued`/`lpYieldPool`
//!      pull-based accrual, just with the funds physically segregated
//!      rather than tracked in storage slots.
//!
//! ## Pre-graduation vs post-graduation
//!
//! Architecture §8 states: "EVM's `preGradFeeBps` and `postGradFeeBps`
//! collapse to a single field for the v1 surface; the pre/post split lives
//! on `AmmState.is_graduated` and the **destinations** split handles the
//! difference."
//!
//! In the EVM contract, pre-grad routes 100% of `fee` to bBase + LP-mint,
//! while post-grad applies the 4-way split. On Solana v1 we simplify
//! further: this ix always applies the 4-way split. Pre-graduation LP
//! tokens are minted separately by `seed_lp` (which uses its own
//! WAD->LP-share math against `cost_wad`, not against the fee USDC).
//!
//! ## Body (architecture §8)
//!
//! 1. Read `total_usdc = market_fee_pool.amount`. Require > 0.
//! 2. Read split bps from `config`. Compute four slice amounts:
//!      `to_b_base       = total * b_base_share_bps       / 10_000`
//!      `to_lp_yield     = total * lp_yield_share_bps     / 10_000`
//!      `to_adjudicator  = total * adjudicator_share_bps  / 10_000`
//!      `to_protocol     = total - to_b_base - to_lp_yield - to_adjudicator`
//!    Floor division for the first three; remainder to `to_protocol` so
//!    no dust is lost. Mirrors EVM `_distributePostGrad:386` (`fee -
//!    toBBase - toLPYield - toAdjudicator`).
//! 3. Four CPI `token::transfer` calls signed by `fee_pool_authority` PDA.
//! 4. Emit `MarketFeesDistributed` with `market.market_id` and the four
//!    slice amounts.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothLaunchpadError;
use crate::events::MarketFeesDistributed;
use crate::state::ProtocolConfig;

#[derive(Accounts)]
pub struct DistributeFees<'info> {
    /// Singleton `ProtocolConfig` PDA. Source of the four split bps and the
    /// canonical `treasury` pubkey — the `protocol_treasury_vault` ATA must
    /// be owned by `config.treasury` (the address constraint below
    /// transitively pins it).
    #[account(
        seeds = [b"protocol_config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    /// Market whose per-market fee pool is drained by this crank.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Box<Account<'info, sooth_market::state::Market>>,

    /// Signer-only PDA — the authority on every per-market fee-pool token
    /// account. Owned by `sooth_launchpad`, signs the four `token::transfer`
    /// CPIs out of the pool. The matching SDK derivation is in
    /// `packages/sdk-solana/src/pdas.ts`'s `deriveFeePoolAuthorityPda`.
    /// CHECK: signer-only PDA derived via seeds.
    #[account(
        seeds = [b"fee_pool_authority"],
        bump,
    )]
    pub fee_pool_authority: UncheckedAccount<'info>,

    /// USDC mint reference. Pinned to canonical USDC so all four downstream
    /// `token::mint` checks transitively bind to the same mint.
    #[account(address = sooth_protocol_types::BASE_TOKEN_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// Per-market fee-pool TokenAccount. Source of all four transfers.
    /// Drained-then-zero on every successful crank.
    #[account(
        mut,
        seeds = [b"market_fee_pool", market.market_id.as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = fee_pool_authority,
    )]
    pub market_fee_pool: Box<Account<'info, TokenAccount>>,

    /// bBase fee destination. ATA whose owner pubkey is left to the v1
    /// integrator (e.g. a per-market `seed_lp` PDA, or the protocol
    /// treasury for now). Mint is canonical USDC.
    #[account(mut, token::mint = usdc_mint)]
    pub b_base_yield_vault: Box<Account<'info, TokenAccount>>,

    /// LP-yield ATA. Owned by the LP-yield PDA (out of scope here; the
    /// owner check will be enforced when `seed_lp` lands and binds the
    /// PDA). Mint is canonical USDC.
    #[account(mut, token::mint = usdc_mint)]
    pub lp_yield_vault: Box<Account<'info, TokenAccount>>,

    /// Adjudicator-fee ATA. v1 caveat: with a global pool we lose
    /// per-market adjudicator attribution — the deposited slice is the
    /// aggregate over all markets. EVM's `adjudicatorAccrued[market]`
    /// will be re-derivable from the indexer using `PositionTraded`
    /// events + the configured fee_bps; on-chain we just batch-deposit
    /// into a single ATA. See "future work" at module bottom.
    #[account(mut, token::mint = usdc_mint)]
    pub adjudicator_fee_vault: Box<Account<'info, TokenAccount>>,

    /// Protocol treasury ATA. Pinned to `config.treasury` so the canonical
    /// per-deploy treasury cannot be substituted at crank time.
    #[account(mut, address = config.treasury, token::mint = usdc_mint)]
    pub protocol_treasury_vault: Box<Account<'info, TokenAccount>>,

    /// Anyone can crank fee distribution — it's a pure split with no
    /// authority gate. Mirrors EVM `FeeRouter._distribute`'s `external`
    /// permissionless surface. Pays the tx fee.
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

pub(crate) fn compute_fee_split(total: u64, cfg: &ProtocolConfig) -> Result<FeeSplit> {
    // ── 2. Compute 4-way split (floor div with remainder-to-protocol) ────
    //
    // Mirrors EVM `_distributePostGrad` line 386: `toProtocol = fee -
    // toBBase - toLPYield - toAdjudicator`. Floor division for the first
    // three slices, remainder lands in `to_protocol`. Guarantees the sum
    // of the four equals `total` exactly (no dust loss). The split bps
    // are u16; widen to u128 for the multiplication to keep `total *
    // 10_000 ≤ 2^64 * 10_000 < 2^78` well inside u128.
    let b_base_bps = cfg.b_base_share_bps as u128;
    let lp_yield_bps = cfg.lp_yield_share_bps as u128;
    let adjudicator_bps = cfg.adjudicator_share_bps as u128;
    let total_u128 = total as u128;

    let to_b_base: u64 = ((total_u128 * b_base_bps) / 10_000)
        .try_into()
        .map_err(|_| error!(SoothLaunchpadError::MathOverflow))?;
    let to_lp_yield: u64 = ((total_u128 * lp_yield_bps) / 10_000)
        .try_into()
        .map_err(|_| error!(SoothLaunchpadError::MathOverflow))?;
    let to_adjudicator: u64 = ((total_u128 * adjudicator_bps) / 10_000)
        .try_into()
        .map_err(|_| error!(SoothLaunchpadError::MathOverflow))?;
    let to_protocol: u64 = total
        .checked_sub(to_b_base)
        .and_then(|v| v.checked_sub(to_lp_yield))
        .and_then(|v| v.checked_sub(to_adjudicator))
        .ok_or(error!(SoothLaunchpadError::MathOverflow))?;

    // Belt-and-braces: the four slices must sum to total. Defensive — the
    // arithmetic above already guarantees it, but a future field-rotation
    // could trip an off-by-one here and silently strand dust.
    let split_sum = (to_b_base as u128)
        .checked_add(to_lp_yield as u128)
        .and_then(|v| v.checked_add(to_adjudicator as u128))
        .and_then(|v| v.checked_add(to_protocol as u128))
        .ok_or(error!(SoothLaunchpadError::MathOverflow))?;
    require!(
        split_sum == total_u128,
        SoothLaunchpadError::FeeSplitMismatch
    );

    Ok(FeeSplit {
        to_b_base,
        to_lp_yield,
        to_adjudicator,
        to_protocol,
    })
}

pub fn handler(ctx: Context<DistributeFees>) -> Result<()> {
    // ── 1. Read total USDC in the fee pool ───────────────────────────────
    let total: u64 = ctx.accounts.market_fee_pool.amount;
    require!(total > 0, SoothLaunchpadError::NothingToDistribute);

    let split = compute_fee_split(total, &ctx.accounts.config)?;

    // ── 3. PDA-signed CPIs ───────────────────────────────────────────────
    //
    // `fee_pool_authority` is derived under `sooth_launchpad::ID` — we sign
    // for it directly from this program. Four transfers, one per
    // destination. Skip zero-amount transfers (saves CU + skips a no-op
    // CPI; spl-token rejects zero-transfers in some configurations).
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

    // ── 4. Event ─────────────────────────────────────────────────────────
    //
    // `total_wad` is in USDC base units here (not WAD) because the source
    // of truth flipped from `AmmState.fee_b_base_wad` (the original
    // accumulator-on-AmmState design) to `fee_pool_vault.amount`. Indexers
    // can rescale via the WAD scalar (`1e12`) if a WAD-denominated total
    // is needed for backward compatibility. The event field is named
    // `total_wad` for ABI stability; the value semantics changed and the
    // event docs note the unit.
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
