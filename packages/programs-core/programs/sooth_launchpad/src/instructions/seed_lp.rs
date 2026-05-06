//! `seed_lp` — STUB. Pre-graduation LP-mint hook.
//!
//! EVM analogue: `LaunchpadEngine._mintLPTokens` (private, called from
//! `createMarket` post deposit transfer). On Solana the LP-mint step is its
//! own ix because the `LpMint` PDA needs `init` codegen which would push
//! `create_market`'s `try_accounts` frame past the SBF 4 KB ceiling — same
//! constraint that fragmented `sooth_market::initialize_market` into three
//! legs (see that module's comment).
//!
//! ## Status
//!
//! Body is `todo!()`. The Accounts struct is committed so the IDL shape is
//! stable. The three init-target accounts (`lp_mint`, `creator_lp_ata`,
//! `lp_position`) are declared as `UncheckedAccount` with seed validation
//! only — same trick the spike used to keep `try_accounts` under the SBF
//! 4 KB ceiling. The body will hand-roll the CPI inits via `system_program::
//! create_account` + `token::initialize_mint` + the manual ATA create call,
//! rather than relying on Anchor's `init` constraint codegen. This is the
//! standard escape hatch when the constraint codegen is too fat.
//!
//! ## Body when it lands
//!
//! 1. Require `!amm_state.is_graduated`.
//! 2. Manually init `lp_mint` PDA via `system_program::create_account` +
//!    `token::initialize_mint`, mint authority = `protocol_config` PDA.
//! 3. Manually create `creator_lp_ata` via the spl-associated-token
//!    `create_associated_token_account` ix.
//! 4. Manually init `lp_position` PDA via `system_program::create_account` +
//!    discriminator write + Borsh serialize.
//! 5. CPI `token::mint_to` → `creator_lp_ata`, signed by `protocol_config`
//!    PDA. LP amount = `args.lp_amount`.
//! 6. emit a (TBD) `LpSeeded` event.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use sooth_amm::state::AmmState;
use sooth_market::state::Market;

use crate::state::ProtocolConfig;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SeedLpArgs {
    /// LP-token base units to mint to `creator_lp_ata`. Pre-graduation 1:1
    /// with the creator's USDC seed deposit (EVM convention; revisit when we
    /// land an explicit LP price model).
    pub lp_amount: u64,
    /// Creator's seed deposit in WAD, recorded on `LpPosition` for the
    /// dismiss/refund flow (architecture §9).
    pub seed_deposit_wad: u128,
}

#[derive(Accounts)]
#[instruction(args: SeedLpArgs)]
pub struct SeedLp<'info> {
    #[account(
        seeds = [b"protocol_config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    /// Market PDA — owned by `sooth_market`. Read-only.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
        has_one = creator,
    )]
    pub market: Box<Account<'info, Market>>,

    /// AmmState PDA — read `is_graduated` only.
    #[account(
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        seeds::program = sooth_amm::ID,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// LP token mint owned by the launchpad. CHECK: PDA derived via seeds;
    /// init'd by the handler body via manual `create_account` +
    /// `initialize_mint` (Anchor's `init` constraint codegen overflows the
    /// SBF 4 KB stack frame for this Accounts struct — see module comment).
    #[account(
        mut,
        seeds = [b"lp", market.market_id.as_ref()],
        bump,
    )]
    pub lp_mint: UncheckedAccount<'info>,

    /// Creator's LP-token ATA — destination of the `mint_to` CPI. CHECK:
    /// derived via the standard spl-associated-token derivation; init'd
    /// manually in the body.
    #[account(mut)]
    pub creator_lp_ata: UncheckedAccount<'info>,

    /// Per-(creator, market) LP position record. CHECK: PDA derived via
    /// seeds; init'd manually in the body for the same SBF-stack reason as
    /// `lp_mint`.
    #[account(
        mut,
        seeds = [b"lp_position", market.market_id.as_ref(), creator.key().as_ref()],
        bump,
    )]
    pub lp_position: UncheckedAccount<'info>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[allow(unused_variables)]
pub fn handler(ctx: Context<SeedLp>, args: SeedLpArgs) -> Result<()> {
    // See module comment for the full spec when this lands. Architecture §1
    // row 7 + §4.1 (LP minting at create time, pre-graduation).
    todo!("LP mint + LpPosition init; see architecture §1 row 7 + §4.1")
}
