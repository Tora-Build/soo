//! `initialize_fee_pool` — singleton init for the global `fee_pool_vault`.
//!
//! Deprecated for new fee accrual: W5 routes fees to per-market
//! `market_fee_pool` accounts. The global pool remains allocated so
//! `distribute_fees_legacy` can drain pre-W5 balances exactly once without
//! breaking historical PDA derivations.
//!
//! Wave 5A wired `sooth_amm::trade_positions` (and the matching
//! `sell_positions` path) to push the per-trade `fee_usdc` slice into a
//! global SPL token ATA owned by the singleton `fee_pool_authority` PDA
//! (`[b"fee_pool_authority"]`, owned by `sooth_launchpad`). The ATA itself
//! had no on-chain bootstrap ix until now — every buy/sell tripped Anchor's
//! `AccountNotInitialized` (3012) on `fee_pool_vault`.
//!
//! This ix creates that ATA exactly once per cluster deploy. The signer
//! pays the rent-exempt deposit and is otherwise unprivileged — the
//! permissionless surface mirrors the rest of the launchpad bootstrap
//! (`initialize_protocol` and `sooth_market::initialize_adjudicator_allowlist`
//! likewise let any wallet front the rent).
//!
//! ## Single-shot guarantee
//!
//! `init` (not `init_if_needed`) on the canonical ATA address means a
//! second caller hits `account already in use` from the runtime. The
//! address is deterministic (mint + authority + token program), so there's
//! no entropy to collide on.
//!
//! ## BPF stack-frame discipline
//!
//! Both payload-bearing accounts (`fee_pool_vault`, `usdc_mint`) are boxed
//! to keep the `try_accounts` codegen frame under the SBF 4 KB ceiling.
//! Same rationale as `sooth_market::initialize_market_vaults`.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct InitializeFeePool<'info> {
    /// Signer-only PDA — the authority on the global `fee_pool_vault`.
    /// Seeds `[b"fee_pool_authority"]`. CHECK: derived via seeds; no
    /// data, no payload, just the canonical ATA owner pubkey.
    #[account(
        seeds = [b"fee_pool_authority"],
        bump,
    )]
    pub fee_pool_authority: UncheckedAccount<'info>,

    /// USDC mint reference. Pinned to canonical USDC so the ATA derives
    /// off the same address `trade_positions` / `distribute_fees` expect.
    #[account(address = sooth_market::USDC_MINT_DEVNET)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// Global fee-pool ATA — owner = `fee_pool_authority`. Created here
    /// via the `associated_token` constraint; Anchor's `init` codegen
    /// allocates the token account, sets owner+mint, and pays rent
    /// from `signer`.
    #[account(
        init,
        payer = signer,
        associated_token::mint = usdc_mint,
        associated_token::authority = fee_pool_authority,
    )]
    pub fee_pool_vault: Box<Account<'info, TokenAccount>>,

    /// Pays the rent-exempt deposit for the ATA. Permissionless — any
    /// wallet may front the rent; same convention as
    /// `initialize_adjudicator_allowlist`.
    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(_ctx: Context<InitializeFeePool>) -> Result<()> {
    // Empty body. Anchor's `init` constraint on `fee_pool_vault` does the
    // full ATA creation — there's no protocol-state to mutate here.
    Ok(())
}
