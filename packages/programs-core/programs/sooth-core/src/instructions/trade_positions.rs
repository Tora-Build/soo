//! `trade_positions` — buy YES/NO shares against the LMSR.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothCoreError;
use crate::events::{MarketGraduated, PositionTraded};
use crate::math::{cost_delta, wad_mul, wad_to_usdc_ceil, MathError, LN2_WAD};
use crate::state::{require_not_paused, AmmState, Market, Position, ProtocolConfig};

const OUTCOME_NO: u8 = 0;
const OUTCOME_YES: u8 = 1;

#[derive(Accounts)]
pub struct TradePositions<'info> {
    /// `mut` for exactly one write: `book_enabled` is flipped here when
    /// graduation fires. Nothing else in this instruction touches `Market`.
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        constraint = amm_state.market == market.key() @ SoothCoreError::MarketNotOpen,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    #[account(
        init_if_needed,
        payer = user,
        space = Position::SPACE,
        seeds = [b"pos", market.market_id.as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, Position>>,

    /// CHECK: derived via seeds; no data.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = amm_mint,
        token::authority = user,
    )]
    pub user_amm_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = amm_mint,
        token::authority = vault_authority,
        // `VaultAuthorityMismatch`, not `MarketNotOpen`. This fires when the
        // caller passes the wrong vault — which since the token split means the
        // BOOK's vault — and reporting a lifecycle error sends a debugger to
        // look at the market's state instead of at the account they passed.
        constraint = market_vault.key() == market.vault_amm
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(address = crate::constants::AMM_TOKEN_MINT)]
    pub amm_mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [b"fee_pool_amm", market.market_id.as_ref()],
        bump,
        token::mint = amm_mint,
    )]
    pub fee_pool_amm: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"lp", market.market_id.as_ref()],
        bump,
    )]
    pub lp_mint: Box<Account<'info, Mint>>,

    /// CHECK: derived via seeds; signs the mint_to inside mint_lp_for_buy_internal.
    #[account(
        seeds = [b"lp_mint_authority", market.market_id.as_ref()],
        bump,
    )]
    pub lp_mint_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = lp_mint,
        token::authority = user,
    )]
    pub user_lp_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

/// The fee total at which a market graduates, in WAD.
///
/// `b · ln(2)` is the LMSR's maximum possible loss and therefore exactly what
/// the creator deposited, so the old hardcoded rule was "earn back 100% of
/// capital at risk". This generalises the 100% without changing it:
/// `deposit × graduation_bps / 10_000`, identical at 10 000 bps.
///
/// `graduation_bps == 0` means 10 000, not "graduate immediately". A zeroed
/// field is what a config written before this existed deserialises to, and
/// reading that as zero would graduate every market on its first trade.
fn graduation_threshold_wad(b: i128, graduation_bps: u16) -> Result<u128> {
    let deposit_wad: u128 = wad_mul(b, LN2_WAD)
        .map_err(map_math_err)?
        .try_into()
        .map_err(|_| error!(SoothCoreError::MathOverflow))?;
    let bps = if graduation_bps == 0 { 10_000u128 } else { graduation_bps as u128 };
    deposit_wad
        .checked_mul(bps)
        .ok_or(error!(SoothCoreError::MathOverflow))?
        .checked_div(10_000)
        .ok_or(error!(SoothCoreError::MathOverflow))
}

pub fn handler(
    ctx: Context<TradePositions>,
    outcome: u8,
    delta_shares: i128,
    max_cost_wad: u128,
) -> Result<()> {
    require_not_paused(&ctx.accounts.protocol_config)?;
    require!(
        outcome == OUTCOME_NO || outcome == OUTCOME_YES,
        SoothCoreError::InvalidOutcome
    );
    require!(delta_shares != 0, SoothCoreError::ZeroDelta);
    require!(delta_shares > 0, SoothCoreError::SellNotImplemented);

    let market = &ctx.accounts.market;
    require!(market.is_open(), SoothCoreError::MarketNotOpen);

    let now = Clock::get()?.unix_timestamp;
    require!(now >= market.start_time, SoothCoreError::TradingNotStarted);
    require!(now < market.deadline, SoothCoreError::TradingClosed);

    // `graduated_at_entry` is read BEFORE the graduation check below, and the
    // LP mint deliberately gates on this stale value rather than the fresh
    // one. That is a semantic, not an accident of the borrow checker:
    //
    // Graduation fires when accumulated fees reach b*ln(2) — i.e. when fees
    // have repaid the LMSR subsidy. The trade that crosses that threshold paid
    // its fee while the market was still pre-graduation, so it earns LP like
    // every trade before it. Gating on the post-trade flag would mean the
    // trader who completes the repayment pays a fee and receives nothing,
    // while the one immediately before them was paid — an arbitrary cliff.
    //
    // Fragile in one specific way: moving the graduation check above this read,
    // or re-reading the flag at the mint site, silently changes who gets paid.
    // `the_graduating_trade_still_earns_lp` pins it.
    let (amm_q_yes, amm_q_no, amm_b, graduated_at_entry) = {
        let amm = &ctx.accounts.amm_state;
        require!(!amm.is_dismissed, SoothCoreError::MarketDismissed);
        require!(amm.b > 0, SoothCoreError::InvalidLiquidity);
        (amm.q_yes, amm.q_no, amm.b, amm.is_graduated)
    };

    let market_key = market.key();
    let user_key = ctx.accounts.user.key();
    let position_bump = ctx.bumps.position;
    {
        let position = &mut ctx.accounts.position;
        if position.user == Pubkey::default() {
            position.user = user_key;
            position.market = market_key;
            position.bump = position_bump;
        }
    }

    let (d_yes, d_no) = if outcome == OUTCOME_YES {
        (delta_shares, 0i128)
    } else {
        (0i128, delta_shares)
    };

    let cost_wad: i128 =
        cost_delta(amm_q_yes, amm_q_no, amm_b, d_yes, d_no).map_err(map_math_err)?;

    let fee_bps = ctx.accounts.protocol_config.amm_fee_bps;
    let cfg_graduation_bps = ctx.accounts.protocol_config.graduation_bps;
    require!(cost_wad > 0, SoothCoreError::MathOverflow);
    let fee_wad: u128 = (cost_wad as u128)
        .checked_mul(fee_bps as u128)
        .map(|v| v / 10_000)
        .ok_or(error!(SoothCoreError::MathOverflow))?;

    let total_cost_wad: u128 = (cost_wad as u128)
        .checked_add(fee_wad)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    require!(
        total_cost_wad <= max_cost_wad,
        SoothCoreError::SlippageExceeded
    );

    let cost_usdc: u64 = wad_to_usdc_ceil(cost_wad as u128).map_err(map_math_err)?;
    let fee_usdc: u64 = wad_to_usdc_ceil(fee_wad).map_err(map_math_err)?;

    let cost_cpi = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.user_amm_ata.to_account_info(),
            to: ctx.accounts.market_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    );
    token::transfer(cost_cpi, cost_usdc)?;
    ctx.accounts.position.locked_cost_usdc = ctx
        .accounts
        .position
        .locked_cost_usdc
        .checked_add(cost_usdc)
        .ok_or(error!(SoothCoreError::MathOverflow))?;

    if fee_usdc > 0 {
        let fee_cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_amm_ata.to_account_info(),
                to: ctx.accounts.fee_pool_amm.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(fee_cpi, fee_usdc)?;
    }

    ctx.accounts.amm_state.fee_b_base_wad = ctx
        .accounts
        .amm_state
        .fee_b_base_wad
        .checked_add(fee_wad)
        .ok_or(error!(SoothCoreError::MathOverflow))?;

    {
        let mut just_graduated = false;
        {
            let amm = &mut ctx.accounts.amm_state;
            if !amm.is_graduated {
                let threshold_wad = graduation_threshold_wad(amm.b, cfg_graduation_bps)?;
                if amm.fee_b_base_wad >= threshold_wad {
                    amm.is_graduated = true;
                    just_graduated = true;
                    emit!(MarketGraduated {
                        market: amm.market,
                        fees_accumulated_wad: amm.fee_b_base_wad,
                        threshold_wad,
                    });
                }
            }
        }
        // Open the book. Mirrored onto `Market` because `book_place` loads
        // `Market` and not `AmmState` — see `Market::book_enabled`.
        if just_graduated {
            ctx.accounts.market.book_enabled = true;
        }
    }

    {
        let amm = &mut ctx.accounts.amm_state;
        let position = &mut ctx.accounts.position;
        if outcome == OUTCOME_YES {
            amm.q_yes = amm
                .q_yes
                .checked_add(delta_shares)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
            position.yes_shares = position
                .yes_shares
                .checked_add(delta_shares)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
            require!(position.yes_shares >= 0, SoothCoreError::InsufficientShares);
        } else {
            amm.q_no = amm
                .q_no
                .checked_add(delta_shares)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
            position.no_shares = position
                .no_shares
                .checked_add(delta_shares)
                .ok_or(error!(SoothCoreError::MathOverflow))?;
            require!(position.no_shares >= 0, SoothCoreError::InsufficientShares);
        }
    }

    // Pre-graduation LP mint — see `graduated_at_entry` above for why this
    // reads the entry-time flag.
    if !graduated_at_entry && fee_usdc > 0 {
        let market_id = ctx.accounts.market.market_id;
        let lp_mint_authority_bump = ctx.bumps.lp_mint_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"lp_mint_authority",
            market_id.as_ref(),
            &[lp_mint_authority_bump],
        ]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.user_lp_ata.to_account_info(),
                    authority: ctx.accounts.lp_mint_authority.to_account_info(),
                },
                signer_seeds,
            ),
            fee_usdc,
        )?;
    }

    emit!(PositionTraded {
        market: market_key,
        user: user_key,
        outcome,
        delta_shares,
        cost_wad,
        ts: now,
    });

    Ok(())
}

fn map_math_err(_e: MathError) -> Error {
    error!(SoothCoreError::MathOverflow)
}
