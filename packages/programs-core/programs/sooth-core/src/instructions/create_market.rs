//! `create_market` — user-facing one-shot market creation flow.
//!
//! Sets up, in order:
//!
//! 1. Init `Market` PDA (lifecycle = Initializing → Open after step 2)
//! 2. Init `market_vault` and `lock_vault` ATAs (lifecycle → Open)
//! 3. Init `AmmState` PDA

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::Discriminator;
use anchor_spl::associated_token::{self, AssociatedToken, Create};
use anchor_spl::token::{self, InitializeMint, Mint, Token};

use crate::error::SoothCoreError;
use crate::events::MarketCreated;
use crate::state::{AmmState, Market, MarketLifecycle, ProtocolConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateMarketArgs {
    pub market_id: [u8; 16],
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

    /// CHECK: AMM-token ATA owned by `vault_authority`; init'd in handler.
    ///
    /// Same authority as the book vault — a signer-only PDA can own one ATA
    /// per mint, so the split needs no new authority and no new seeds.
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
    let vault_authority_key = ctx.accounts.vault_authority.key();

    // ── Leg 1: Init Market PDA ────────────────────────────────────────────
    {
        let space = Market::SPACE;
        let lamports = ctx.accounts.rent.minimum_balance(space);
        let signer_seeds: &[&[&[u8]]] =
            &[&[b"market", market_id.as_ref(), &[market_bump]]];
        invoke_signed(
            &system_instruction::create_account(
                &creator_key,
                &ctx.accounts.market.key(),
                lamports,
                space as u64,
                &crate::ID,
            ),
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.market.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;
        let market_state = Market {
            // A new market is ungraduated, so the book stays shut until
            // `trade_positions` opens it.
            book_enabled: false,
            _reserved: [0u8; 97],
            market_id,
            creator: creator_key,
            adjudicator: args.adjudicator,
            question_hash: args.question_hash,
            vault_book: Pubkey::default(),  // all three filled after leg 2
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
        associated_token::create(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer: ctx.accounts.creator.to_account_info(),
                associated_token: ctx.accounts.vault_amm.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
                mint: ctx.accounts.amm_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;
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

        let space = AmmState::SPACE;
        let lamports = ctx.accounts.rent.minimum_balance(space);
        let amm_signer: &[&[&[u8]]] = &[&[b"amm", market_id.as_ref(), &[amm_bump]]];
        invoke_signed(
            &system_instruction::create_account(
                &creator_key,
                &ctx.accounts.amm_state.key(),
                lamports,
                space as u64,
                &crate::ID,
            ),
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.amm_state.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            amm_signer,
        )?;
        let market_key = ctx.accounts.market.key();
        let amm = AmmState {
            _reserved: [0u8; 64],
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
