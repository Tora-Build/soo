//! `initialize_market` — create the Market PDA only.
//!
//! Architecture §4.1 (call chain). EVM analogue: `LaunchpadEngine.createMarket`
//! deploying a `TruthMarket` clone + ERC-20 outcome tokens. On Solana the
//! deploy step collapses into native PDA initialization, but the SPL mint /
//! ATA leg is split out into `initialize_market_vaults` because Anchor 0.30.1
//! `try_accounts` codegen overflows the SBF 4 KB stack frame when both legs
//! are in one ix even with every payload-bearing account `Box<>`'d (~6.9 KB
//! frame observed in `cargo build-sbf` warnings; runtime corrupts the
//! `args` struct on the stack — verified empirically against bankrun, see
//! report). The split keeps `try_accounts` lean.
//!
//! ## Accounts created (REAL — no `init_if_needed`; reuse must be impossible)
//!
//! - `Market` PDA           seeds = `[b"market", market_id]`
//!
//! The outcome mints, USDC vault, and lock vault are created by the follow-up
//! `initialize_market_vaults` ix. Their bumps and addresses are computed and
//! stored on `Market` here so the second ix is a pure validate-and-create.
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

use crate::error::SoothMarketError;
use crate::events::MarketInitialized;
use crate::state::{
    AdjudicatorAllowlist, Market, MarketLifecycle, ADJUDICATOR_ALLOWLIST_SEED,
};

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

    /// Singleton allowlist of permitted adjudicator pubkeys. Read-only here;
    /// the handler verifies `args.adjudicator` is present. Codex C2 minimum-
    /// viable mitigation — see `state/adjudicator_allowlist.rs`.
    /// Account-resolution will fail if the allowlist PDA has not been
    /// initialised yet (closed-by-default posture).
    #[account(
        seeds = [ADJUDICATOR_ALLOWLIST_SEED],
        bump = adjudicator_allowlist.bump,
    )]
    pub adjudicator_allowlist: Account<'info, AdjudicatorAllowlist>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeMarket>, args: InitializeMarketArgs) -> Result<()> {
    require!(
        args.deadline > args.start_time,
        SoothMarketError::InvalidDeadline
    );

    // ── Adjudicator gating (Codex C2 minimum-viable mitigation) ───────────
    //
    // 1. Reject the all-zero default pubkey — guards against operators who
    //    forget to set a real adjudicator and would otherwise create a market
    //    that the loose signer-key check on `lock_for_resolution` / `settle`
    //    cannot meaningfully authorise.
    // 2. Reject any pubkey not present on the on-chain allowlist. The
    //    allowlist is a singleton PDA managed by the protocol multisig; this
    //    constrains the SET of valid adjudicators while leaving the per-call
    //    authentication on the lifecycle ixs unchanged in this commit.
    //
    // Future migration: when the full `sooth_adjudicator` program lands,
    // this check is replaced by a CPI-driven verification (the adjudicator
    // program signs into `lock_for_resolution`/`settle` and we verify the
    // CPI parent program). Until then this allowlist is the minimum viable
    // defense per Codex's 2nd-pass review.
    require_keys_neq!(
        args.adjudicator,
        Pubkey::default(),
        SoothMarketError::AdjudicatorIsDefault
    );
    require!(
        ctx.accounts
            .adjudicator_allowlist
            .contains(args.adjudicator),
        SoothMarketError::AdjudicatorNotAllowlisted
    );

    // Compute the addresses + bumps for every per-market PDA up front, even
    // for the accounts that don't exist yet (yes_mint, no_mint, vault_authority,
    // lock_authority). `find_program_address` works without the account being
    // initialized — it's a pure derivation. Storing these on Market means
    // `initialize_market_vaults` is a pure validate-and-create flow.
    let market_id_seed = args.market_id.as_ref();
    let program_id = ctx.program_id;
    let (_vault_authority, vault_authority_bump) =
        Pubkey::find_program_address(&[b"vault", market_id_seed], program_id);
    let (_lock_authority, lock_authority_bump) =
        Pubkey::find_program_address(&[b"lock", market_id_seed], program_id);
    let (yes_mint, yes_mint_bump) =
        Pubkey::find_program_address(&[b"mint", market_id_seed, b"y"], program_id);
    let (no_mint, no_mint_bump) =
        Pubkey::find_program_address(&[b"mint", market_id_seed, b"n"], program_id);

    let market = &mut ctx.accounts.market;
    market.market_id = args.market_id;
    market.creator = ctx.accounts.creator.key();
    market.adjudicator = args.adjudicator;
    market.question_hash = args.question_hash;
    market.yes_mint = yes_mint;
    market.no_mint = no_mint;
    // `vault` / `lock_vault` are ATA-derived; we leave them as default until
    // `initialize_market_vaults` populates them with the real addresses (which
    // depend on the canonical USDC mint and so are computed there, not here).
    market.vault = Pubkey::default();
    market.lock_vault = Pubkey::default();
    market.start_time = args.start_time;
    market.deadline = args.deadline;
    // Start in `Initializing` — flips to `Open` when `initialize_market_vaults`
    // completes the SPL leg. Trades against `Initializing` are rejected by
    // `Market::is_open()` in `sooth_amm`.
    market.lifecycle = MarketLifecycle::Initializing;
    market.winning_outcome = 0;
    market.bump = ctx.bumps.market;
    market.vault_authority_bump = vault_authority_bump;
    market.lock_authority_bump = lock_authority_bump;
    market.yes_mint_bump = yes_mint_bump;
    market.no_mint_bump = no_mint_bump;

    let now = Clock::get()?.unix_timestamp;
    emit!(MarketInitialized {
        market: market.key(),
        creator: market.creator,
        adjudicator: market.adjudicator,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        // Vault is populated by the follow-up ix; emit `default` here and a
        // second `MarketInitialized`-like event from `initialize_market_vaults`
        // would be redundant. Indexers should treat `vault == default()` as
        // "vault leg pending".
        vault: market.vault,
        start_time: market.start_time,
        deadline: market.deadline,
        ts: now,
    });

    Ok(())
}
