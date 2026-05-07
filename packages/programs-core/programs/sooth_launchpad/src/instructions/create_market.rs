//! `create_market` — user-facing one-shot market creation flow.
//!
//! Architecture §4.1. EVM analogue: `LaunchpadEngine.createMarket`
//! (`LaunchpadEngine.sol:204-339`). On Solana this is a single ix that
//! composes four sequential CPIs into `sooth_market` and `sooth_amm`,
//! collapsing the 4-tx seed flow (initializeMarket → initializeOutcomeMints →
//! initializeMarketVaults → initializeAmmState) into one transaction:
//!
//! 1. `sooth_market::initialize_market`         (lifecycle = Initializing)
//! 2. `sooth_market::initialize_outcome_mints`  (lifecycle = Initializing)
//! 3. `sooth_market::initialize_market_vaults`  (lifecycle → Open)
//! 4. `sooth_amm::initialize_amm_state`         (Open + AmmState ready)
//!
//! ## BPF stack-frame discipline
//!
//! Anchor 0.30.1 emits the full `try_accounts` codegen for this Accounts
//! struct on build, including for `Box<Account<…>>` fields whose payload is
//! heap-allocated. Every payload-bearing account here is `Box<…>` to keep
//! the union of the four inner CPIs' account lists under the SBF 4 KB
//! frame; `UncheckedAccount` fields don't deserialise so they cost only the
//! 32-byte pubkey. The 4 KB ceiling applies per program invocation, and
//! each inner CPI gets its own fresh frame, so the only risk is this outer
//! `try_accounts`. See the matching rationale in
//! `sooth_market::initialize_market.rs`.
//!
//! ## Account ordering
//!
//! Ordering follows the four CPI legs so the runtime's flat account-index
//! space is minimally re-sliced per CPI. **Do not reorder** without
//! re-validating the per-leg `cpi::accounts::*` struct shapes.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token};

use sooth_market::state::{AdjudicatorAllowlist, ADJUDICATOR_ALLOWLIST_SEED};

use crate::events::MarketCreated;
use crate::state::ProtocolConfig;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateMarketArgs {
    /// Deterministic 16-byte id (truncated keccak256 of question || creator
    /// || nonce). Architecture §2.2. Forwarded to leg 1.
    pub market_id: [u8; 16],
    pub question_hash: [u8; 32],
    pub start_time: i64,
    pub deadline: i64,
    /// Adjudicator program id. Forwarded to leg 1
    /// (`sooth_market::initialize_market`).
    pub adjudicator: Pubkey,
    /// Initial LMSR liquidity `b` in WAD. Forwarded to leg 4
    /// (`sooth_amm::initialize_amm_state`). Must be > 0 and ≤ i128::MAX.
    pub initial_b: u128,
}

/// Account layout = union of the four CPI legs' accounts. Ordering matches
/// the CPI invocation order so the runtime's flat account-index space is
/// minimally re-sliced per leg. **Do not reorder** without re-validating
/// the CPI account-meta arrays in the handler.
#[derive(Accounts)]
#[instruction(args: CreateMarketArgs)]
pub struct CreateMarket<'info> {
    /// Global protocol config. Read-only here — used to (a) source the
    /// `default_trial_period` for the `trial_end_at` computation passed to
    /// leg 4, and (b) anchor the IDL surface for any future "permissioned"
    /// mode. Architecture §9.
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

    /// Singleton allowlist of permitted adjudicator pubkeys. Read-only here;
    /// the inner `initialize_market` handler verifies `args.adjudicator` is
    /// present (Codex C2 minimum-viable mitigation). The PDA must already
    /// have been bootstrapped via `sooth_market::initialize_adjudicator_allowlist`
    /// before any `create_market` call lands.
    #[account(
        seeds = [ADJUDICATOR_ALLOWLIST_SEED],
        bump = adjudicator_allowlist.bump,
        seeds::program = sooth_market::ID,
    )]
    pub adjudicator_allowlist: Box<Account<'info, AdjudicatorAllowlist>>,

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

    /// USDC mint. Pinned at `address = sooth_market::USDC_MINT_DEVNET` so
    /// the canonical-USDC chain is unforgeable from the IDL surface alone
    /// (mirrors the H1 fix on `initialize_market_vaults`). The inner CPI
    /// re-asserts the same constraint.
    #[account(address = sooth_market::USDC_MINT_DEVNET)]
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

pub fn handler(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
    // ── Leg 1: sooth_market::initialize_market ──────────────────────────
    //
    // Creates the Market PDA, validates the adjudicator against the
    // singleton allowlist, and stores the per-market PDA bumps. The inner
    // handler asserts `args.deadline > args.start_time` so we don't pre-
    // validate here.
    {
        let cpi_accounts = sooth_market::cpi::accounts::InitializeMarket {
            market: ctx.accounts.market.to_account_info(),
            adjudicator_allowlist: ctx.accounts.adjudicator_allowlist.to_account_info(),
            creator: ctx.accounts.creator.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.sooth_market_program.to_account_info(),
            cpi_accounts,
        );
        sooth_market::cpi::initialize_market(
            cpi_ctx,
            sooth_market::instructions::InitializeMarketArgs {
                market_id: args.market_id,
                question_hash: args.question_hash,
                start_time: args.start_time,
                deadline: args.deadline,
                adjudicator: args.adjudicator,
            },
        )?;
    }

    // ── Leg 2: sooth_market::initialize_outcome_mints ───────────────────
    //
    // Creates `yes_mint` and `no_mint` SPL mints with `vault_authority` as
    // mint authority. The inner handler re-derives the mint addresses
    // from the now-populated `Market` PDA's stored bumps.
    {
        let cpi_accounts = sooth_market::cpi::accounts::InitializeOutcomeMints {
            market: ctx.accounts.market.to_account_info(),
            vault_authority: ctx.accounts.vault_authority.to_account_info(),
            yes_mint: ctx.accounts.yes_mint.to_account_info(),
            no_mint: ctx.accounts.no_mint.to_account_info(),
            creator: ctx.accounts.creator.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            rent: ctx.accounts.rent.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.sooth_market_program.to_account_info(),
            cpi_accounts,
        );
        sooth_market::cpi::initialize_outcome_mints(cpi_ctx)?;
    }

    // ── Leg 3: sooth_market::initialize_market_vaults ───────────────────
    //
    // Creates the USDC vault + lock-vault ATAs and flips lifecycle
    // Initializing → Open. The inner handler pins `usdc_mint` to
    // `USDC_MINT_DEVNET` (H1) — we re-pin on the outer Accounts struct so
    // the IDL surface advertises the same constraint.
    {
        let cpi_accounts = sooth_market::cpi::accounts::InitializeMarketVaults {
            market: ctx.accounts.market.to_account_info(),
            vault_authority: ctx.accounts.vault_authority.to_account_info(),
            lock_authority: ctx.accounts.lock_authority.to_account_info(),
            usdc_mint: ctx.accounts.usdc_mint.to_account_info(),
            vault: ctx.accounts.vault.to_account_info(),
            lock_vault: ctx.accounts.lock_vault.to_account_info(),
            creator: ctx.accounts.creator.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
            rent: ctx.accounts.rent.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.sooth_market_program.to_account_info(),
            cpi_accounts,
        );
        sooth_market::cpi::initialize_market_vaults(cpi_ctx)?;
    }

    // ── Leg 4: sooth_amm::initialize_amm_state ──────────────────────────
    //
    // Initializes the per-market AMM cursor with `initial_b` and the
    // computed `trial_end_at`. Architecture §9 formula:
    //
    //   trial_duration = min(0.3 × (deadline - now), default_trial_period)
    //   trial_end_at   = now + trial_duration
    //
    // Saturating arithmetic guards against pathological deadlines (in the
    // past, or so far future the multiply would overflow `i64`). The inner
    // handler re-asserts `initial_b > 0` and `initial_b ≤ i128::MAX`
    // (M1 in security review), so we don't pre-validate here.
    let now = Clock::get()?.unix_timestamp;
    let trial_end_at = compute_trial_end_at(
        now,
        args.deadline,
        ctx.accounts.config.default_trial_period,
    );
    {
        let cpi_accounts = sooth_amm::cpi::accounts::InitializeAmmState {
            market: ctx.accounts.market.to_account_info(),
            amm_state: ctx.accounts.amm_state.to_account_info(),
            creator: ctx.accounts.creator.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.sooth_amm_program.to_account_info(),
            cpi_accounts,
        );
        sooth_amm::cpi::initialize_amm_state(
            cpi_ctx,
            sooth_amm::instructions::InitializeAmmStateArgs {
                initial_b: args.initial_b,
                trial_end_at,
            },
        )?;
    }

    // ── Emit MarketCreated ──────────────────────────────────────────────
    //
    // Mirrors EVM `LaunchpadEngine.MarketCreated`. Indexers can pin the
    // resulting market PDA + companion mints/vault without re-deriving.
    emit!(MarketCreated {
        market: ctx.accounts.market.key(),
        creator: ctx.accounts.creator.key(),
        adjudicator: args.adjudicator,
        yes_mint: ctx.accounts.yes_mint.key(),
        no_mint: ctx.accounts.no_mint.key(),
        vault: ctx.accounts.vault.key(),
        initial_b: args.initial_b,
        start_time: args.start_time,
        deadline: args.deadline,
        ts: now,
    });

    Ok(())
}

/// Compute `trial_end_at` per architecture §9:
///
///   trial_duration = min(0.3 × (deadline - now), default_trial_period)
///   trial_end_at   = now + trial_duration
///
/// `0.3` is encoded as the integer ratio `3 / 10`. All arithmetic is
/// saturating so a deadline in the past, a deadline so far in the future
/// the multiply would overflow `i64`, or a negative `default_trial_period`
/// (impossible per `initialize_protocol` invariants but defended in depth)
/// each collapse to `now`. The downstream
/// `sooth_amm::initialize_amm_state` accepts any `i64`, so we don't need
/// to bound the result further.
fn compute_trial_end_at(now: i64, deadline: i64, default_trial_period: i64) -> i64 {
    let until_deadline = deadline.saturating_sub(now);
    if until_deadline <= 0 {
        return now;
    }
    let scaled = until_deadline.saturating_mul(3) / 10;
    let trial = scaled.min(default_trial_period.max(0));
    now.saturating_add(trial)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trial_end_uses_thirty_percent_of_window_when_smaller_than_default() {
        // 1000s window, 1_000_000s default → 30% × 1000 = 300s.
        assert_eq!(compute_trial_end_at(0, 1_000, 1_000_000), 300);
    }

    #[test]
    fn trial_end_clamped_to_default_when_window_is_huge() {
        // 1_000_000s window, 100s default → 30% × 1_000_000 = 300_000, clamped to 100.
        assert_eq!(compute_trial_end_at(0, 1_000_000, 100), 100);
    }

    #[test]
    fn trial_end_zero_when_deadline_is_in_the_past() {
        assert_eq!(compute_trial_end_at(1_000, 500, 1_000_000), 1_000);
    }

    #[test]
    fn trial_end_zero_when_deadline_equals_now() {
        assert_eq!(compute_trial_end_at(1_000, 1_000, 1_000_000), 1_000);
    }

    #[test]
    fn trial_end_handles_negative_default_trial_period_defensively() {
        // `initialize_protocol` rejects this, but defense-in-depth.
        assert_eq!(compute_trial_end_at(0, 1_000, -1), 0);
    }

    #[test]
    fn trial_end_saturating_on_huge_deadline() {
        // deadline = i64::MAX, now = 0 → saturating multiply by 3 saturates,
        // then div by 10 → still huge but capped by default_trial_period.
        let trial = compute_trial_end_at(0, i64::MAX, 100);
        assert_eq!(trial, 100);
    }
}
