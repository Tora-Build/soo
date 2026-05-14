//! `initialize_amm_state` — create the per-market AMM cursor.
//!
//! Adapted from `sooth_amm::initialize_amm_state`. `seeds::program` on
//! `market` is removed (everything is now in the same program).

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::state::{AmmState, Market};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeAmmStateArgs {
    pub initial_b: u128,
    pub trial_end_at: i64,
}

#[derive(Accounts)]
pub struct InitializeAmmState<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = creator,
        space = AmmState::SPACE,
        seeds = [b"amm", market.market_id.as_ref()],
        bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    #[account(
        mut,
        constraint = creator.key() == market.creator @ SoothCoreError::Unauthorized,
    )]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeAmmState>, args: InitializeAmmStateArgs) -> Result<()> {
    require!(args.initial_b > 0, SoothCoreError::InvalidLiquidity);
    require!(
        args.initial_b <= i128::MAX as u128,
        SoothCoreError::InvalidLiquidity
    );

    let amm = &mut ctx.accounts.amm_state;
    amm.market = ctx.accounts.market.key();
    amm.q_yes = 0;
    amm.q_no = 0;
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
