//! `create_market` — user-facing one-shot market creation flow.
//!
//! Sets up, in order:
//!
//! 1. Init `Market` PDA (lifecycle = Initializing → Open after step 2)
//! 2. Init `market_vault` and `lock_vault` ATAs (lifecycle → Open)
//! 3. Init `AmmState` PDA

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::associated_token::{self, AssociatedToken, Create};
use anchor_spl::token::{self, InitializeAccount3, Mint, Token};

use anchor_lang::solana_program::hash::hash;

use crate::constants::MAX_QUESTION_LEN;
use crate::error::SoothCoreError;
use crate::events::MarketCreated;
use crate::pda::create_pda_account;
use crate::state::{AmmState, Market, MarketLifecycle, ProtocolConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateMarketArgs {
    pub market_id: [u8; 16],
    /// The question, in full.
    ///
    /// Only its hash is stored — `Market` keeps 32 bytes and the text is not
    /// persisted anywhere on chain. But it IS emitted in `MarketCreated`, so a
    /// client can recover it from the creation transaction without an indexer;
    /// the event is the only retrievable copy of the words a market asked.
    ///
    /// Verified against `question_hash` below, which is what makes the event
    /// trustworthy: without the check, a creator could store the hash of one
    /// question and broadcast the text of another, and nothing downstream
    /// could tell.
    pub question: String,
    pub question_hash: [u8; 32],
    pub start_time: i64,
    pub deadline: i64,
    /// Adjudicator pubkey recorded on Market. An `AdjudicatorEntry` PDA must
    /// be created separately via `register_adjudicator`.
    pub adjudicator: Pubkey,
    pub initial_b: u128,
}

#[derive(Accounts)]
#[instruction(args: CreateMarketArgs)]
pub struct CreateMarket<'info> {
    /// Global protocol config. Checked for `paused` flag.
    #[account(
        seeds = [b"protocol_config"],
        bump = config.bump,
        constraint = !config.paused @ SoothCoreError::ProtocolPaused,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    // ── Market PDA ──────────────────────────────────────────────────────
    /// CHECK: PDA-derived; hand-rolled init in handler.
    #[account(
        mut,
        seeds = [b"market", args.market_id.as_ref()],
        bump,
    )]
    pub market: UncheckedAccount<'info>,

    // ── Outcome mints ────────────────────────────────────────────────────
    /// CHECK: signer-only PDA; mint authority for outcome mints.
    #[account(
        seeds = [b"vault", args.market_id.as_ref()],
        bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    // ── Market vaults ────────────────────────────────────────────────────
    /// CHECK: signer-only PDA; lock-vault authority.
    #[account(
        seeds = [b"lock", args.market_id.as_ref()],
        bump,
    )]
    pub lock_authority: UncheckedAccount<'info>,

    #[account(address = crate::constants::BOOK_TOKEN_MINT)]
    pub book_mint: Box<Account<'info, Mint>>,

    #[account(address = crate::constants::AMM_TOKEN_MINT)]
    pub amm_mint: Box<Account<'info, Mint>>,

    /// CHECK: book-token ATA owned by `vault_authority`; init'd in handler.
    #[account(mut)]
    pub vault_book: UncheckedAccount<'info>,

    /// CHECK: AMM-token account at seeds `[b"vault_amm", market_id]`, owned by
    /// `vault_authority`; created and initialized in the handler, which
    /// re-derives the address before signing.
    ///
    /// Its own PDA, NOT an ATA. The book vault is the vault authority's ATA,
    /// and an ATA is one account per (authority, mint) pair: a deployment that
    /// fills both venue roles with the same mint would collapse the two vaults
    /// into one and merge venue accounting. Own seeds keep the vaults distinct
    /// under any mint pairing, while the token-account authority stays
    /// `vault_authority`, so every downstream transfer path signs identically.
    #[account(mut)]
    pub vault_amm: UncheckedAccount<'info>,

    /// CHECK: AMM-token ATA owned by `lock_authority`; init'd in handler.
    #[account(mut)]
    pub lock_vault: UncheckedAccount<'info>,

    // ── AMM state ────────────────────────────────────────────────────────
    /// CHECK: AmmState PDA; hand-rolled init in handler.
    #[account(
        mut,
        seeds = [b"amm", args.market_id.as_ref()],
        bump,
    )]
    pub amm_state: UncheckedAccount<'info>,

    // ── Common ───────────────────────────────────────────────────────────
    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
    require!(
        args.deadline > args.start_time,
        SoothCoreError::InvalidDeadline
    );
    require!(
        args.adjudicator != Pubkey::default(),
        SoothCoreError::AdjudicatorIsDefault
    );
    // Bounded so the instruction cannot be used to push arbitrary data
    // through the transaction, and so `MarketCreated` stays inside the log
    // size a client can actually read back.
    require!(
        !args.question.is_empty() && args.question.len() <= MAX_QUESTION_LEN,
        SoothCoreError::InvalidQuestion
    );
    // The stored hash must be the hash of the emitted text. This is the whole
    // basis on which a reader may trust the event.
    require!(
        hash(args.question.as_bytes()).to_bytes() == args.question_hash,
        SoothCoreError::QuestionHashMismatch
    );

    require!(args.initial_b > 0, SoothCoreError::InvalidLiquidity);
    require!(
        args.initial_b <= i128::MAX as u128,
        SoothCoreError::InvalidLiquidity
    );

    let market_id = args.market_id;
    let market_bump = ctx.bumps.market;
    let vault_authority_bump = ctx.bumps.vault_authority;
    let lock_authority_bump = ctx.bumps.lock_authority;
    let amm_bump = ctx.bumps.amm_state;

    let creator_key = ctx.accounts.creator.key();

    // ── Leg 1: Init Market PDA ────────────────────────────────────────────
    {
        // `create_pda_account`, not a bare `create_account`: this address is
        // sha256(question)-derived and therefore public before the market
        // exists, so one lamport sent here would otherwise censor the
        // question forever. The helper still refuses a live Market or the
        // tombstone of a closed one.
        create_pda_account(
            &ctx.accounts.creator.to_account_info(),
            &ctx.accounts.market.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.rent,
            Market::SPACE,
            &crate::ID,
            &[b"market", market_id.as_ref(), &[market_bump]],
        )?;
        let market_state = Market {
            // A new market is ungraduated, so the book stays shut until
            // `trade_positions` opens it.
            book_enabled: false,
            // Dismissal is a decision the creator takes later, inside the
            // trial window.
            is_dismissed: false,
            _reserved: [0u8; 96],
            market_id,
            creator: creator_key,
            adjudicator: args.adjudicator,
            question_hash: args.question_hash,
            vault_book: Pubkey::default(), // all three filled after leg 2
            vault_amm: Pubkey::default(),
            lock_vault: Pubkey::default(),
            start_time: args.start_time,
            deadline: args.deadline,
            lifecycle: MarketLifecycle::Initializing,
            winning_outcome: 0,
            bump: market_bump,
            vault_authority_bump,
            lock_authority_bump,
        };
        let mut data = ctx.accounts.market.try_borrow_mut_data()?;
        data[..8].copy_from_slice(&Market::DISCRIMINATOR);
        use anchor_lang::AnchorSerialize;
        market_state.serialize(&mut &mut data[8..])?;
    }

    // ── Leg 2: Init market vaults (lifecycle → Open) ──────────────────────
    {
        associated_token::create(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer: ctx.accounts.creator.to_account_info(),
                associated_token: ctx.accounts.vault_book.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
                mint: ctx.accounts.book_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;
        {
            // The AMM vault at its own seeds. create_account must be signed
            // by the new account itself, so the vault PDA's seeds sign.
            let (vault_amm_key, vault_amm_bump) =
                Pubkey::find_program_address(&[b"vault_amm", market_id.as_ref()], &crate::ID);
            require_keys_eq!(
                vault_amm_key,
                ctx.accounts.vault_amm.key(),
                SoothCoreError::VaultAuthorityMismatch
            );
            create_pda_account(
                &ctx.accounts.creator.to_account_info(),
                &ctx.accounts.vault_amm.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                &ctx.accounts.rent,
                anchor_spl::token::TokenAccount::LEN,
                &anchor_spl::token::ID,
                &[b"vault_amm", market_id.as_ref(), &[vault_amm_bump]],
            )?;
            token::initialize_account3(CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                InitializeAccount3 {
                    account: ctx.accounts.vault_amm.to_account_info(),
                    mint: ctx.accounts.amm_mint.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
            ))?;
        }
        associated_token::create(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer: ctx.accounts.creator.to_account_info(),
                associated_token: ctx.accounts.lock_vault.to_account_info(),
                authority: ctx.accounts.lock_authority.to_account_info(),
                mint: ctx.accounts.amm_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;

        // Update market with vault addresses and transition lifecycle → Open.
        let vault_book_key = ctx.accounts.vault_book.key();
        let vault_amm_key = ctx.accounts.vault_amm.key();
        let lock_vault_key = ctx.accounts.lock_vault.key();
        let mut data = ctx.accounts.market.try_borrow_mut_data()?;
        use anchor_lang::{AccountDeserialize, AccountSerialize};
        let mut slice: &[u8] = &data;
        let mut m = Market::try_deserialize(&mut slice)?;
        m.vault_book = vault_book_key;
        m.vault_amm = vault_amm_key;
        m.lock_vault = lock_vault_key;
        m.lifecycle = MarketLifecycle::Open;
        m.try_serialize(&mut &mut data[..])?;
    }

    // ── Leg 3: Init AmmState ──────────────────────────────────────────────
    {
        let now = Clock::get()?.unix_timestamp;
        let trial_end_at =
            compute_trial_end_at(now, args.deadline, ctx.accounts.config.default_trial_period);

        create_pda_account(
            &ctx.accounts.creator.to_account_info(),
            &ctx.accounts.amm_state.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.rent,
            AmmState::SPACE,
            &crate::ID,
            &[b"amm", market_id.as_ref(), &[amm_bump]],
        )?;
        let market_key = ctx.accounts.market.key();
        let amm = AmmState {
            _reserved: [0u8; 54],
            // Nothing is owed yet, and this market counts from zero — which
            // is what makes the counter readable as a total later. Accounts
            // written before this field existed leave the flag clear, and
            // `reclaim_subsidy` refuses to trust their counter.
            refund_obligation_usdc: 0,
            tracks_refund_obligation: true,
            // `seed_lp` posts the subsidy; until it runs the curve has no
            // liquidity and the trading paths refuse the market.
            is_seeded: false,
            market: market_key,
            q_yes: 0,
            q_no: 0,
            b: args.initial_b as i128,
            seed_q_yes: 0,
            seed_q_no: 0,
            fee_b_base_wad: 0,
            trial_end_at,
            is_graduated: false,
            is_dismissed: false,
            bump: amm_bump,
        };
        let mut data = ctx.accounts.amm_state.try_borrow_mut_data()?;
        data[..8].copy_from_slice(&AmmState::DISCRIMINATOR);
        use anchor_lang::AnchorSerialize;
        amm.serialize(&mut &mut data[8..])?;
    }

    let now = Clock::get()?.unix_timestamp;
    emit!(MarketCreated {
        question: args.question.clone(),
        market: ctx.accounts.market.key(),
        creator: creator_key,
        adjudicator: args.adjudicator,
        vault_book: ctx.accounts.vault_book.key(),
        vault_amm: ctx.accounts.vault_amm.key(),
        initial_b: args.initial_b,
        start_time: args.start_time,
        deadline: args.deadline,
        ts: now,
    });

    Ok(())
}

/// Compute `trial_end_at` per architecture §9.
///
///   trial_duration = min(0.3 × (deadline - now), default_trial_period)
///   trial_end_at   = now + trial_duration
pub(crate) fn compute_trial_end_at(now: i64, deadline: i64, default_trial_period: i64) -> i64 {
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
        assert_eq!(compute_trial_end_at(0, 1_000, 1_000_000), 300);
    }

    #[test]
    fn trial_end_clamped_to_default_when_window_is_huge() {
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
        assert_eq!(compute_trial_end_at(0, 1_000, -1), 0);
    }

    #[test]
    fn trial_end_saturating_on_huge_deadline() {
        let trial = compute_trial_end_at(0, i64::MAX, 100);
        assert_eq!(trial, 100);
    }
}
