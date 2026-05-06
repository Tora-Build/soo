//! `initialize_amm_state` — create the per-market AMM cursor.
//!
//! The `AmmState` PDA is read by `trade_positions` (architecture §2.2) but
//! no on-chain ix previously created it; the smoke test had to hand-write
//! the account via `bankrun.setAccount`. This ix closes that gap.
//!
//! Accounts kept boxed (Market + AmmState) to stay under the SBF 4 KB
//! `try_accounts` stack-frame ceiling — see the matching note in
//! `sooth_market::initialize_market.rs`.

use anchor_lang::prelude::*;

use crate::error::SoothAmmError;
use crate::state::{AmmState, Market};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeAmmStateArgs {
    /// Initial LMSR liquidity parameter `b` in WAD. Must be > 0.
    /// Architecture §2.2 / §4.2 — `b` controls the curve's price elasticity;
    /// the SDK's `WAD * 1000` default mirrors the LMSR golden test.
    pub initial_b: u128,
    /// `trial_end_at` from architecture §4.2 — usually `market.deadline` so
    /// the trial / graduation accumulator window closes on settle. Stored
    /// alongside `b` to keep this ix arg-driven (the alternative — read it
    /// off `Market` — would re-introduce the cross-program type-coupling
    /// the spec calls out as load-bearing).
    pub trial_end_at: i64,
}

#[derive(Accounts)]
pub struct InitializeAmmState<'info> {
    /// The Market PDA — owned by `sooth_market`. PDA pinning mirrors the
    /// pattern in `trade_positions::TradePositions`.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Box<Account<'info, Market>>,

    /// Per-market AMM cursor — `init` (not `init_if_needed`) so re-init is
    /// impossible on the same market.
    #[account(
        init,
        payer = creator,
        space = AmmState::SPACE,
        seeds = [b"amm", market.market_id.as_ref()],
        bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// Must match `market.creator` (architecture §4.1 — the creator-deposits-
    /// seed-liquidity flow). Re-using the equality check via `has_one` so
    /// Anchor's discriminator validation doesn't deserialize Market twice.
    #[account(
        mut,
        constraint = creator.key() == market.creator @ SoothAmmError::Unauthorized,
    )]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeAmmState>, args: InitializeAmmStateArgs) -> Result<()> {
    require!(args.initial_b > 0, SoothAmmError::InvalidLiquidity);
    // M1 (Codex): bound `initial_b` to the i128 positive range so the
    // `as i128` cast below cannot wrap to a negative value. Without this
    // check, `u128` values above `i128::MAX` reinterpret as negative `b`,
    // bricking the AMM permanently (LMSR `cost_delta` underflows on every
    // trade). The `>= i128::MAX as u128` boundary is fine: the value space
    // beyond it is well past any plausible market liquidity (~1.7e38 WAD).
    require!(
        args.initial_b <= i128::MAX as u128,
        SoothAmmError::InvalidLiquidity
    );

    let amm = &mut ctx.accounts.amm_state;
    amm.market = ctx.accounts.market.key();
    amm.q_yes = 0;
    amm.q_no = 0;
    // `b` is i128 on `AmmState` even though it's logically positive — see the
    // field doc on `state/amm_state.rs`. Convert via `as i128` after the
    // require-positive bound, which guarantees the high bit is clear so the
    // signed reinterpretation is lossless.
    amm.b = args.initial_b as i128;
    amm.seed_q_yes = 0;
    amm.seed_q_no = 0;
    amm.fee_b_base_wad = 0;
    amm.trial_end_at = args.trial_end_at;
    amm.is_graduated = false;
    amm.is_dismissed = false;
    amm.bump = ctx.bumps.amm_state;

    Ok(())
}
