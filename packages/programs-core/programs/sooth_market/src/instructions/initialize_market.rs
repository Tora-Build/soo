//! `initialize_market` — create the Market PDA, outcome mints, and USDC vault.
//!
//! Architecture §4.1 (call chain). EVM analogue: `LaunchpadEngine.createMarket`
//! deploying a `TruthMarket` clone + ERC-20 outcome tokens. On Solana the
//! deploy step collapses into native PDA initialization, all in one ix.
//!
//! ## Accounts created (REAL — no `init_if_needed`; reuse must be impossible)
//!
//! - `Market` PDA           seeds = `[b"market", market_id]`
//! - `yes_mint` SPL Mint     seeds = `[b"mint", market_id, b"y"]`,
//!                           mint_authority = `vault_authority` PDA, decimals = 6
//! - `no_mint`  SPL Mint     seeds = `[b"mint", market_id, b"n"]`,
//!                           mint_authority = `vault_authority` PDA, decimals = 6
//! - `vault`    USDC ATA     owner = `vault_authority` PDA
//! - `lock_vault` USDC ATA   owner = `lock_authority` PDA
//!
//! `vault_authority` and `lock_authority` are signer-only PDAs (no data
//! account; only their signer seeds are used). Bumps stored on `Market`.
//!
//! ## Outcome mint decimals
//!
//! 6 to match USDC. Complete-set semantics are 1:1:1 (1 USDC in → 1 YES + 1 NO
//! out at base-unit granularity), so matching decimals avoids per-call
//! rescaling. EVM uses 18-decimal WAD shares; the Solana side stores the AMM
//! `q_yes`/`q_no` in WAD on `AmmState` but the *outcome SPL token* is at
//! USDC-decimal granularity for direct settlement against the vault. This is
//! a deliberate v1 simplification — flag in report.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::SoothMarketError;
use crate::events::MarketInitialized;
use crate::state::{Market, MarketLifecycle};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeMarketArgs {
    /// Deterministic 16-byte id (truncated keccak256 of question || creator
    /// || nonce). Architecture §2.2.
    pub market_id: [u8; 16],
    pub question_hash: [u8; 32],
    pub start_time: i64,
    pub deadline: i64,
    /// Adjudicator program id. The CPI auth check on lifecycle setters will
    /// validate against this — left as `todo!()` for now.
    pub adjudicator: Pubkey,
}

#[derive(Accounts)]
#[instruction(args: InitializeMarketArgs)]
pub struct InitializeMarket<'info> {
    /// New Market PDA. `init` (not `init_if_needed`) — re-init must be
    /// impossible on this account.
    #[account(
        init,
        payer = creator,
        space = Market::SPACE,
        seeds = [b"market", args.market_id.as_ref()],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// Signer-only PDA. Mint authority for both outcome mints, owner of
    /// `vault`. CHECK: the signer-seed derivation alone is the safety
    /// constraint — there is no on-chain data on this account.
    /// CHECK: derived via seeds; safe.
    #[account(
        seeds = [b"vault", args.market_id.as_ref()],
        bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Signer-only PDA. Owner of `lock_vault` (AMM 24h sell-cooldown escrow).
    /// CHECK: derived via seeds; safe.
    #[account(
        seeds = [b"lock", args.market_id.as_ref()],
        bump,
    )]
    pub lock_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = creator,
        seeds = [b"mint", args.market_id.as_ref(), b"y"],
        bump,
        mint::decimals = 6,
        mint::authority = vault_authority,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        seeds = [b"mint", args.market_id.as_ref(), b"n"],
        bump,
        mint::decimals = 6,
        mint::authority = vault_authority,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    /// USDC mint reference. Pinned by the SDK to canonical mainnet USDC
    /// (`EPjFW...`) or the cluster-appropriate devnet faucet equivalent.
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// Market USDC vault — created as the ATA of `vault_authority`.
    #[account(
        init,
        payer = creator,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// AMM lock-on-sell escrow vault. See `lock_vault` placement note in
    /// `state/market.rs` and architecture §4.3.
    #[account(
        init,
        payer = creator,
        associated_token::mint = usdc_mint,
        associated_token::authority = lock_authority,
    )]
    pub lock_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<InitializeMarket>, args: InitializeMarketArgs) -> Result<()> {
    require!(
        args.deadline > args.start_time,
        SoothMarketError::InvalidDeadline
    );

    let market = &mut ctx.accounts.market;
    market.market_id = args.market_id;
    market.creator = ctx.accounts.creator.key();
    market.adjudicator = args.adjudicator;
    market.question_hash = args.question_hash;
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.vault = ctx.accounts.vault.key();
    market.lock_vault = ctx.accounts.lock_vault.key();
    market.start_time = args.start_time;
    market.deadline = args.deadline;
    // Happy-path: open immediately. The transient `Initializing` state exists
    // for a future "configure then open" flow (e.g. adjudicator-deposited
    // bond). v1 doesn't use it.
    market.lifecycle = MarketLifecycle::Open;
    market.winning_outcome = 0;
    market.bump = ctx.bumps.market;
    market.vault_authority_bump = ctx.bumps.vault_authority;
    market.lock_authority_bump = ctx.bumps.lock_authority;
    market.yes_mint_bump = ctx.bumps.yes_mint;
    market.no_mint_bump = ctx.bumps.no_mint;

    let now = Clock::get()?.unix_timestamp;
    emit!(MarketInitialized {
        market: market.key(),
        creator: market.creator,
        adjudicator: market.adjudicator,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        vault: market.vault,
        start_time: market.start_time,
        deadline: market.deadline,
        ts: now,
    });

    Ok(())
}
