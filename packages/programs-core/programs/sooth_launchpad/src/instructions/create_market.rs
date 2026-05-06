//! `create_market` — STUB. The user-facing one-shot market creation flow.
//!
//! Architecture §4.1. EVM analogue: `LaunchpadEngine.createMarket`
//! (`LaunchpadEngine.sol:204-339`). On Solana this is the higher-level wrapper
//! around four sequential CPIs into `sooth_market` and `sooth_amm` — see the
//! enumerated list in the handler body.
//!
//! ## Status
//!
//! Body is `todo!()`. The Accounts struct is real and committed so the IDL
//! shape is stable for the SDK.
//!
//! ## Why a stub now
//!
//! - **CPI plumbing is non-trivial**: each leg needs the union of *its own*
//!   accounts plus the right `signer_seeds` for the `vault_authority` /
//!   `lock_authority` PDAs that `sooth_market` derives. The launchpad PDA
//!   (`protocol_config`) is *not* a signer for those — they're per-market
//!   PDAs owned by `sooth_market`. The CPI handlers expect the original
//!   creator to sign, which means `create_market` re-passes the user's
//!   signer through to each leg.
//! - **Stack frame headroom**: composing four CPIs in one ix means the
//!   `try_accounts` codegen here ends up holding the union of every leg's
//!   account list (~20+ accounts boxed). Anchor 0.30.1 SBF codegen runs hot
//!   on this and we want to land it after we've measured a baseline frame.
//! - **Account ordering**: Solana's runtime imposes a strict 4-deep CPI cap
//!   and a flat account-index space; getting the order right needs a
//!   live-validator round-trip to verify.
//!
//! All three are scoped for a follow-up commit. The TODO inside the handler
//! has the exact CPI list.
//!
//! ## BPF stack-frame discipline
//!
//! Every payload-bearing account is `Box<Account<…>>`. Even with a `todo!()`
//! body, Anchor still emits the full `try_accounts` codegen on build, which
//! is the path that overflows the 4 KB SBF stack frame. Mirror the
//! `sooth_market::initialize_market` rationale: box everything that holds
//! >32 bytes of data.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token};

use crate::state::ProtocolConfig;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateMarketArgs {
    /// Deterministic 16-byte id (truncated keccak256 of question || creator
    /// || nonce). Architecture §2.2. Same field as
    /// `sooth_market::InitializeMarketArgs::market_id` — passed through to
    /// leg 1.
    pub market_id: [u8; 16],
    pub question_hash: [u8; 32],
    pub start_time: i64,
    pub deadline: i64,
    /// Adjudicator program id. Forwarded to leg 1
    /// (`sooth_market::initialize_market`).
    pub adjudicator: Pubkey,
    /// Initial LMSR liquidity `b` in WAD. Forwarded to leg 4
    /// (`sooth_amm::initialize_amm_state`).
    pub initial_b: u128,
}

/// Account layout = union of the four CPI legs' accounts. Ordering matches
/// the CPI invocation order so the runtime's flat account-index space is
/// minimally re-sliced per leg. **Do not reorder** without re-validating
/// the CPI account-meta arrays in the handler.
#[derive(Accounts)]
#[instruction(args: CreateMarketArgs)]
pub struct CreateMarket<'info> {
    /// Global protocol config. Read-only here — used to (a) enforce
    /// `creator == config.authority` if the cluster is in "permissioned"
    /// mode, and (b) source the `default_trial_period` when leg 4 computes
    /// `trial_end_at`. Architecture §9.
    #[account(
        seeds = [b"protocol_config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    // ── Leg 1: sooth_market::initialize_market ──────────────────────────
    /// New Market PDA. Owned by `sooth_market`; the CPI in leg 1 will `init`
    /// it. UncheckedAccount here — the CPI handler does the real Anchor
    /// validation. CHECK: derived via seeds + initialized by inner program.
    #[account(
        mut,
        seeds = [b"market", args.market_id.as_ref()],
        bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: UncheckedAccount<'info>,

    // ── Leg 2: sooth_market::initialize_outcome_mints ───────────────────
    /// CHECK: signer-only PDA derived via seeds; mint authority for the
    /// outcome mints. Inner CPI re-asserts.
    #[account(
        seeds = [b"vault", args.market_id.as_ref()],
        bump,
        seeds::program = sooth_market::ID,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: PDA-derived SPL mint, init'd by leg 2 CPI.
    #[account(
        mut,
        seeds = [b"mint", args.market_id.as_ref(), b"y"],
        bump,
        seeds::program = sooth_market::ID,
    )]
    pub yes_mint: UncheckedAccount<'info>,

    /// CHECK: PDA-derived SPL mint, init'd by leg 2 CPI.
    #[account(
        mut,
        seeds = [b"mint", args.market_id.as_ref(), b"n"],
        bump,
        seeds::program = sooth_market::ID,
    )]
    pub no_mint: UncheckedAccount<'info>,

    // ── Leg 3: sooth_market::initialize_market_vaults ───────────────────
    /// CHECK: signer-only PDA derived via seeds; lock-vault authority.
    #[account(
        seeds = [b"lock", args.market_id.as_ref()],
        bump,
        seeds::program = sooth_market::ID,
    )]
    pub lock_authority: UncheckedAccount<'info>,

    /// USDC mint. Pinned at `address = sooth_market::USDC_MINT_DEVNET` once
    /// the CPI body lands; left as a `Mint` account here so the IDL shape
    /// is committed.
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// CHECK: USDC ATA owned by `vault_authority`. Init'd by leg 3 CPI.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: USDC ATA owned by `lock_authority`. Init'd by leg 3 CPI.
    #[account(mut)]
    pub lock_vault: UncheckedAccount<'info>,

    // ── Leg 4: sooth_amm::initialize_amm_state ──────────────────────────
    /// CHECK: AmmState PDA owned by `sooth_amm`; init'd by leg 4 CPI.
    #[account(
        mut,
        seeds = [b"amm", args.market_id.as_ref()],
        bump,
        seeds::program = sooth_amm::ID,
    )]
    pub amm_state: UncheckedAccount<'info>,

    // ── Common ──────────────────────────────────────────────────────────
    /// Creator + payer for every leg. Each CPI re-checks
    /// `signer == market.creator` so we don't need to pin it here.
    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: `sooth_market` program account, target of legs 1-3 CPIs.
    #[account(address = sooth_market::ID)]
    pub sooth_market_program: UncheckedAccount<'info>,

    /// CHECK: `sooth_amm` program account, target of leg 4 CPI.
    #[account(address = sooth_amm::ID)]
    pub sooth_amm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[allow(unused_variables)]
pub fn handler(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
    // The CPI body composes the four-leg init flow from architecture §4.1.
    // Each leg's CPI signature, accounts, and arg shape is already known —
    // see the per-leg comment block above. Spec for the body when it lands:
    //
    //   1. `sooth_market::initialize_market`         (Initializing)
    //         args: { market_id, question_hash, start_time, deadline, adjudicator }
    //   2. `sooth_market::initialize_outcome_mints`  (Initializing)
    //         no args; pulls mints from the cached `Market` PDA.
    //   3. `sooth_market::initialize_market_vaults`  (Initializing → Open)
    //         no args; pins `usdc_mint` to `USDC_MINT_DEVNET` inside the
    //         called handler (H1 in security review).
    //   4. `sooth_amm::initialize_amm_state`         (Open + AmmState ready)
    //         args: { initial_b, trial_end_at }
    //         where `trial_end_at` = compute from `config.default_trial_period`
    //         and (deadline - now) per architecture §9 formula:
    //             min(0.3 × (deadline - now), default_trial_period)
    //
    // Then emit `MarketCreated` once all four legs land.
    todo!("compose sooth_market::initialize_market + initialize_outcome_mints + initialize_market_vaults + sooth_amm::initialize_amm_state via CPI; see architecture §4.1")
}
