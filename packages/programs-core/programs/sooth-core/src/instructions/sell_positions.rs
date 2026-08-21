//! `sell_positions` — sell YES/NO shares against the LMSR with lock-on-sell.
//!
//! Uses PDA-signed token transfers:
//!   - `token::transfer(market_vault → fee_pool_amm)`.
//!   - `token::transfer(market_vault → lock_vault)`.
//!
//! The fee also advances `AmmState.fee_b_base_wad` and runs the graduation
//! check, exactly as `trade_positions` does — see §6a.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothCoreError;
use crate::events::{MarketGraduated, PositionSold};
use crate::instructions::trade_positions::graduation_threshold_wad;
use crate::math::{cost_delta, wad_to_usdc_floor, MathError};
use crate::state::market::{OUTCOME_NO, OUTCOME_YES};
use crate::state::{
    require_not_paused, require_seeded, AmmState, LockEntry, Market, Position, ProtocolConfig,
};

const LOCK_DURATION_SECS: i64 = 24 * 60 * 60;

#[derive(Accounts)]
#[instruction(_outcome: u8, _delta_shares: i128, _min_proceeds_wad: u128, lock_nonce: u64)]
pub struct SellPositions<'info> {
    /// `mut` for exactly one write: `book_enabled` is flipped here when the
    /// sell's fee carries the graduation odometer over its threshold. Nothing
    /// else in this instruction touches `Market`.
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

    /// Per-(user, market) Position. Must already exist — you can only
    /// sell shares you've previously bought.
    #[account(
        mut,
        seeds = [b"pos", market.market_id.as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = user @ SoothCoreError::Unauthorized,
        has_one = market @ SoothCoreError::Unauthorized,
    )]
    pub position: Box<Account<'info, Position>>,

    /// CHECK: derived via seeds; signs the vault outflow CPIs.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: derived via seeds; signs the lock_vault outflow.
    #[account(
        seeds = [b"lock", market.market_id.as_ref()],
        bump = market.lock_authority_bump,
    )]
    pub lock_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = amm_mint,
        token::authority = vault_authority,
        // `VaultAuthorityMismatch`, not `MarketNotOpen`. This fires when the
        // caller passes the wrong vault — with per-venue vaults that means the
        // BOOK's vault — and reporting a lifecycle error sends a debugger to
        // look at the market's state instead of at the account they passed.
        constraint = market_vault.key() == market.vault_amm
            @ SoothCoreError::VaultAuthorityMismatch,
        // The seeding gate, mirroring `trade_positions`. An unseeded market
        // has no curve to sell into; the error names that rather than letting
        // the sell price shares against liquidity that was never posted.
        constraint = amm_state.is_seeded_with(market_vault.amount)
            @ SoothCoreError::MarketNotSeeded,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = amm_mint,
        token::authority = lock_authority,
        constraint = lock_vault.key() == market.lock_vault @ SoothCoreError::LockVaultMismatch,
    )]
    pub lock_vault: Box<Account<'info, TokenAccount>>,

    /// New `LockEntry` PDA. Seeds `[b"lock_entry", position.key(), lock_nonce.to_le_bytes()]`.
    /// The `lock_nonce` instruction parameter must equal `position.lock_nonce`.
    #[account(
        init,
        payer = user,
        space = LockEntry::SPACE,
        seeds = [
            b"lock_entry",
            position.key().as_ref(),
            &lock_nonce.to_le_bytes(),
        ],
        bump,
    )]
    pub lock_entry: Box<Account<'info, LockEntry>>,

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

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<SellPositions>,
    outcome: u8,
    delta_shares: i128,
    min_proceeds_wad: u128,
    lock_nonce: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.protocol_config)?;
    require!(
        outcome == OUTCOME_NO || outcome == OUTCOME_YES,
        SoothCoreError::InvalidOutcome
    );
    require!(delta_shares < 0, SoothCoreError::ZeroDelta);
    // Verify the caller-supplied lock_nonce matches the current position nonce.
    require_eq!(
        lock_nonce,
        ctx.accounts.position.lock_nonce,
        SoothCoreError::OrderIdSeedMismatch
    );

    require!(ctx.accounts.market.is_open(), SoothCoreError::MarketNotOpen);

    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.market.start_time,
        SoothCoreError::TradingNotStarted
    );
    require!(
        now < ctx.accounts.market.deadline,
        SoothCoreError::TradingClosed
    );

    let market_key = ctx.accounts.market.key();
    let market_id = ctx.accounts.market.market_id;

    require!(
        !ctx.accounts.amm_state.is_dismissed,
        SoothCoreError::MarketDismissed
    );
    // Restated in the handler so the invariant survives a refactor of the
    // account struct; the constraint above is what the caller sees first.
    require_seeded(&ctx.accounts.amm_state, ctx.accounts.market_vault.amount)?;
    require!(
        ctx.accounts.amm_state.b > 0,
        SoothCoreError::InvalidLiquidity
    );

    let (d_yes, d_no) = if outcome == OUTCOME_YES {
        (delta_shares, 0i128)
    } else {
        (0i128, delta_shares)
    };

    let cost_wad: i128 = cost_delta(
        ctx.accounts.amm_state.q_yes,
        ctx.accounts.amm_state.q_no,
        ctx.accounts.amm_state.b,
        d_yes,
        d_no,
    )
    .map_err(map_math_err)?;

    require!(cost_wad <= 0, SoothCoreError::MathOverflow);
    let proceeds_wad: u128 = cost_wad.unsigned_abs();

    let fee_bps = ctx.accounts.protocol_config.amm_fee_bps;
    let cfg_graduation_bps = ctx.accounts.protocol_config.graduation_bps;
    let fee_wad: u128 = proceeds_wad
        .checked_mul(fee_bps as u128)
        .map(|v| v / 10_000)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    let net_proceeds_wad = proceeds_wad.saturating_sub(fee_wad);

    if min_proceeds_wad > 0 {
        require!(
            net_proceeds_wad >= min_proceeds_wad,
            SoothCoreError::SlippageExceeded
        );
    }

    let proceeds_usdc_pre_split: u64 = wad_to_usdc_floor(proceeds_wad).map_err(map_math_err)?;
    let fee_usdc: u64 = wad_to_usdc_floor(fee_wad).map_err(map_math_err)?;
    let net_proceeds_usdc: u64 = wad_to_usdc_floor(net_proceeds_wad).map_err(map_math_err)?;
    let vault_outflow_usdc = net_proceeds_usdc
        .checked_add(fee_usdc)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    require!(
        vault_outflow_usdc <= proceeds_usdc_pre_split,
        SoothCoreError::MathOverflow
    );

    // ── 5. State mutation ─────────────────────────────────────────────────
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

    // ── 6. PDA-signed fee transfer: market_vault → fee_pool_amm ────────
    let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
    let vault_signer_seeds: &[&[&[u8]]] =
        &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

    if fee_usdc > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.fee_pool_amm.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                vault_signer_seeds,
            ),
            fee_usdc,
        )?;
    }

    // ── 6a. The fee joins the graduation odometer ─────────────────────────
    //
    // Sell fees count toward graduation exactly as buy fees do. The odometer
    // measures fees the venue has EARNED against the subsidy the creator put
    // at risk (`b·ln(2) × graduation_bps`), and a sell's fee lands in
    // `fee_pool_amm` alongside a buy's. Accruing only one side would make the
    // odometer disagree with the pool it is measuring, and would make a
    // churn-heavy market harder to graduate than a buy-only one that earned
    // the protocol the same money.
    ctx.accounts.amm_state.fee_b_base_wad = ctx
        .accounts
        .amm_state
        .fee_b_base_wad
        .checked_add(fee_wad)
        .ok_or(error!(SoothCoreError::MathOverflow))?;

    // The check runs at both trading sites, so graduation stays atomic with
    // the trade that crosses the threshold rather than waiting for the next
    // buy. It is still one-way, and `AmmState.is_graduated` and
    // `Market.book_enabled` are still written together.
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
        if just_graduated {
            ctx.accounts.market.book_enabled = true;
        }
    }

    // ── 6b. PDA-signed net transfer: market_vault → lock_vault ────────────
    if net_proceeds_usdc > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.lock_vault.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                vault_signer_seeds,
            ),
            net_proceeds_usdc,
        )?;
    }

    // The refund claim shrinks by what left the vault, floored at zero: a
    // position that sold out at a profit is owed nothing on a dismissal, not
    // a negative. The market-wide total must move by the SAME amount, which
    // is the floored delta and not `vault_outflow_usdc` — subtracting the raw
    // outflow would over-retire the total by exactly the position's profit
    // and leave the counter under the sum it mirrors.
    let claim_before = ctx.accounts.position.locked_cost_usdc;
    let retired = claim_retired(claim_before, vault_outflow_usdc);
    ctx.accounts.position.locked_cost_usdc = claim_before - retired;
    // Saturating on the aggregate: an account written before the counter
    // existed carries positions the counter never saw, so its total can be
    // below the claim being retired. Failing there would strand the sell path
    // on every legacy market; clamping at zero only ever UNDER-states what is
    // still owed on an account whose counter is already marked untrustworthy.
    ctx.accounts.amm_state.retire_refund_obligation(retired);

    // ── 7. Populate the LockEntry ─────────────────────────────────────────
    let unlock_at = now
        .checked_add(LOCK_DURATION_SECS)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    let nonce_at_init = lock_nonce; // validated == position.lock_nonce above
    let lock_entry_bump = ctx.bumps.lock_entry;
    let user_key = ctx.accounts.user.key();
    {
        let lock_entry = &mut ctx.accounts.lock_entry;
        lock_entry.user = user_key;
        lock_entry.market = market_key;
        lock_entry.amount_usdc = net_proceeds_usdc;
        lock_entry.unlock_at = unlock_at;
        lock_entry.nonce = nonce_at_init;
        lock_entry.bump = lock_entry_bump;
    }

    // ── 8. Bump the lock-nonce counter ────────────────────────────────────
    let new_nonce = nonce_at_init
        .checked_add(1)
        .ok_or(error!(SoothCoreError::MathOverflow))?;
    ctx.accounts.position.lock_nonce = new_nonce;

    // ── 9. Emit ───────────────────────────────────────────────────────────
    let lock_entry_key = ctx.accounts.lock_entry.key();
    emit!(PositionSold {
        market: market_key,
        user: user_key,
        outcome,
        shares_sold: delta_shares.unsigned_abs(),
        lock_entry: lock_entry_key,
        amount_usdc: net_proceeds_usdc,
        unlock_at,
    });

    Ok(())
}

/// How much of a position's refund claim a sell retires.
///
/// The claim floors at zero — a position that sold out at a profit is owed
/// nothing on a dismissal, not a negative — so the amount retired is the
/// vault outflow capped by what the claim still stood at. The market-wide
/// total must move by THIS, not by the raw outflow: subtracting the outflow
/// would over-retire the total by exactly the position's profit.
pub(crate) fn claim_retired(claim_before: u64, vault_outflow_usdc: u64) -> u64 {
    claim_before.min(vault_outflow_usdc)
}

fn map_math_err(_e: MathError) -> Error {
    error!(SoothCoreError::MathOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::amm_state::{amm_fixture, legacy_amm_fixture};

    #[test]
    fn an_unseeded_market_refuses_to_sell() {
        // The sell path loads no LP mint, so nothing else stops it. Without
        // this guard a sell would price shares against liquidity that was
        // never posted.
        let mut amm = amm_fixture();
        amm.is_seeded = false;
        assert!(require_seeded(&amm, 0).is_err());
    }

    #[test]
    fn a_legacy_seeded_market_still_sells() {
        assert!(require_seeded(&legacy_amm_fixture(), 1).is_ok());
    }

    #[test]
    fn a_sell_retires_no_more_of_the_claim_than_the_claim_holds() {
        // The profitable round trip: the position takes out more than it put
        // in. Its claim floors at zero, so the market-wide total must fall by
        // the floored amount — retiring the raw outflow would push the total
        // below the sum it mirrors by exactly the profit.
        assert_eq!(claim_retired(1_000, 400), 400);
        assert_eq!(claim_retired(1_000, 1_000), 1_000);
        assert_eq!(claim_retired(1_000, 2_500), 1_000);
        assert_eq!(claim_retired(0, 900), 0);
    }
}
