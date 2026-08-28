//! Bonded optimistic resolution — the four instructions.
//!
//! `opt_propose`   anyone asserts the outcome with a bond, post-deadline,
//!                 on a market with no registered adjudicator.
//! `opt_challenge` anyone posts a matching bond inside the window.
//! `opt_finalize`  unchallenged + window elapsed → the assertion settles the
//!                 market and the bond comes home. Permissionless crank.
//! `opt_arbitrate` challenged → the market's designated adjudicator
//!                 (`Market.adjudicator`, recorded at creation) rules, the
//!                 loser's bond pays the winner, the ruling settles.
//!
//! Settlement here walks the same Open→Locked→Settled lifecycle as the
//! adjudicated path and emits the same `MarketLocked`/`MarketSettled`
//! events, so every downstream reader — redemption, reputation, the UI —
//! sees an optimistic market end exactly like any other. If the market was
//! settled through another path first (a creator registering late and
//! ruling), the bond flows still complete: money must never depend on
//! winning the race.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::SoothCoreError;
use crate::events::{
    ChallengeArbitrated, MarketLocked, MarketSettled, OutcomeProposed, ProposalChallenged,
    ProposalFinalized,
};
use crate::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use crate::state::{
    Market, MarketLifecycle, OptimisticProposal, OPT_BOND_AUTHORITY_SEED, OPT_BOND_VAULT_SEED,
    OPT_CHALLENGE_WINDOW_SECS, OPT_MIN_BOND, OPT_PROPOSAL_SEED,
};

fn require_outcome(outcome: u8) -> Result<()> {
    require!(
        outcome == OUTCOME_NO || outcome == OUTCOME_YES || outcome == OUTCOME_INVALID,
        SoothCoreError::InvalidOutcome
    );
    Ok(())
}

/// Open → Locked → Settled, or a no-op when another path already ended the
/// market. Returns whether THIS call performed the settlement.
fn settle_market(
    market: &mut Market,
    market_key: Pubkey,
    outcome: u8,
    now: i64,
) -> Result<bool> {
    // Settled AND dismissed are both terminal no-ops here, not errors: the
    // bond payout that follows this call must complete regardless of how the
    // market ended, or a dismissal would strand every escrowed bond forever.
    if matches!(market.lifecycle, MarketLifecycle::Settled) || market.is_dismissed {
        return Ok(false);
    }
    if matches!(market.lifecycle, MarketLifecycle::Open) {
        market.lifecycle = MarketLifecycle::Locked;
        emit!(MarketLocked {
            market: market_key,
            ts: now,
        });
    }
    require!(
        market
            .lifecycle
            .can_transition_to(MarketLifecycle::Settled),
        SoothCoreError::InvalidLifecycleTransition
    );
    market.lifecycle = MarketLifecycle::Settled;
    market.winning_outcome = outcome;
    emit!(MarketSettled {
        market: market_key,
        winning_outcome: outcome,
        ts: now,
    });
    Ok(true)
}

// ─── opt_propose ────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct OptPropose<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: the ELIGIBILITY gate. Must be the market's adjudicator-entry
    /// PDA and must be EMPTY — a market with a registered adjudicator
    /// (manual or zk) owns its resolution path and cannot be raced by a
    /// proposer. Verified by seeds; emptiness checked in the handler.
    #[account(
        seeds = [crate::state::ADJUDICATOR_ENTRY_SEED, market.key().as_ref()],
        bump,
    )]
    pub adjudicator_entry: UncheckedAccount<'info>,

    #[account(
        init,
        payer = proposer,
        space = OptimisticProposal::SIZE,
        seeds = [OPT_PROPOSAL_SEED, market.key().as_ref()],
        bump,
    )]
    pub proposal: Box<Account<'info, OptimisticProposal>>,

    /// The bond currency is the book venue's collateral — the market's own
    /// settlement token, so a slashed bond is immediately meaningful money.
    #[account(constraint = bond_mint.key() == vault_book.mint @ SoothCoreError::OptBondMintMismatch)]
    pub bond_mint: Box<Account<'info, Mint>>,

    #[account(constraint = vault_book.key() == market.vault_book @ SoothCoreError::AmmStateMarketMismatch)]
    pub vault_book: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA that owns the bond vault; signs payouts.
    #[account(
        seeds = [OPT_BOND_AUTHORITY_SEED, market.key().as_ref()],
        bump,
    )]
    pub bond_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = proposer,
        seeds = [OPT_BOND_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = bond_mint,
        token::authority = bond_authority,
    )]
    pub bond_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = bond_mint,
        token::authority = proposer,
    )]
    pub proposer_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub proposer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn propose(ctx: Context<OptPropose>, outcome: u8, bond: u64) -> Result<()> {
    require_outcome(outcome)?;
    require!(bond >= OPT_MIN_BOND, SoothCoreError::OptBondTooSmall);

    let market = &ctx.accounts.market;
    require!(!market.is_dismissed, SoothCoreError::MarketDismissed);
    require!(
        matches!(market.lifecycle, MarketLifecycle::Open),
        SoothCoreError::InvalidLifecycleTransition
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now >= market.deadline, SoothCoreError::OptTooEarly);
    // The absence check that IS the opt-in: no adjudicator entry, no owner
    // of the truth, so the bonded game may begin.
    require!(
        ctx.accounts.adjudicator_entry.data_is_empty(),
        SoothCoreError::OptNotEligible
    );

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.proposer_ata.to_account_info(),
                to: ctx.accounts.bond_vault.to_account_info(),
                authority: ctx.accounts.proposer.to_account_info(),
            },
        ),
        bond,
    )?;

    let p = &mut ctx.accounts.proposal;
    p.market = market.key();
    p.proposer = ctx.accounts.proposer.key();
    p.outcome = outcome;
    p.bond = bond;
    p.proposed_at = now;
    p.challenger = Pubkey::default();
    p.challenged_at = 0;
    p.resolved = false;
    p.bump = ctx.bumps.proposal;
    p.vault_bump = ctx.bumps.bond_vault;
    p.auth_bump = ctx.bumps.bond_authority;

    emit!(OutcomeProposed {
        market: market.key(),
        proposer: p.proposer,
        outcome,
        bond,
        ts: now,
    });
    Ok(())
}

// ─── opt_challenge ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct OptChallenge<'info> {
    #[account(
        mut,
        seeds = [OPT_PROPOSAL_SEED, proposal.market.as_ref()],
        bump = proposal.bump,
    )]
    pub proposal: Box<Account<'info, OptimisticProposal>>,

    #[account(
        mut,
        seeds = [OPT_BOND_VAULT_SEED, proposal.market.as_ref()],
        bump = proposal.vault_bump,
    )]
    pub bond_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = bond_vault.mint,
        token::authority = challenger,
    )]
    pub challenger_ata: Box<Account<'info, TokenAccount>>,

    pub challenger: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn challenge(ctx: Context<OptChallenge>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let p = &ctx.accounts.proposal;
    require!(!p.resolved, SoothCoreError::OptAlreadyResolved);
    require!(!p.is_challenged(), SoothCoreError::OptAlreadyChallenged);
    require!(
        now <= p.proposed_at + OPT_CHALLENGE_WINDOW_SECS,
        SoothCoreError::OptChallengeWindowClosed
    );
    // A proposer "challenging" themselves would only park their own money —
    // but it would also block every honest challenger, so refuse it.
    require!(
        ctx.accounts.challenger.key() != p.proposer,
        SoothCoreError::OptSelfChallenge
    );

    let bond = p.bond;
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.challenger_ata.to_account_info(),
                to: ctx.accounts.bond_vault.to_account_info(),
                authority: ctx.accounts.challenger.to_account_info(),
            },
        ),
        bond,
    )?;

    let p = &mut ctx.accounts.proposal;
    p.challenger = ctx.accounts.challenger.key();
    p.challenged_at = now;

    emit!(ProposalChallenged {
        market: p.market,
        challenger: p.challenger,
        bond,
        ts: now,
    });
    Ok(())
}

// ─── opt_finalize ───────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct OptFinalize<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        constraint = proposal.market == market.key() @ SoothCoreError::AmmStateMarketMismatch,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [OPT_PROPOSAL_SEED, market.key().as_ref()],
        bump = proposal.bump,
    )]
    pub proposal: Box<Account<'info, OptimisticProposal>>,

    #[account(
        mut,
        seeds = [OPT_BOND_VAULT_SEED, market.key().as_ref()],
        bump = proposal.vault_bump,
    )]
    pub bond_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: seeds-verified vault authority.
    #[account(
        seeds = [OPT_BOND_AUTHORITY_SEED, market.key().as_ref()],
        bump = proposal.auth_bump,
    )]
    pub bond_authority: UncheckedAccount<'info>,

    /// The bond goes home and nowhere else.
    #[account(
        mut,
        token::mint = bond_vault.mint,
        constraint = proposer_ata.owner == proposal.proposer @ SoothCoreError::OptWrongRecipient,
    )]
    pub proposer_ata: Box<Account<'info, TokenAccount>>,

    /// Permissionless crank, exactly like `settle`.
    pub cranker: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn finalize(ctx: Context<OptFinalize>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    {
        let p = &ctx.accounts.proposal;
        require!(!p.resolved, SoothCoreError::OptAlreadyResolved);
        require!(!p.is_challenged(), SoothCoreError::OptAlreadyChallenged);
        require!(
            now > p.proposed_at + OPT_CHALLENGE_WINDOW_SECS,
            SoothCoreError::OptChallengeWindowOpen
        );
    }

    let outcome = ctx.accounts.proposal.outcome;
    let market_key = ctx.accounts.market.key();
    settle_market(&mut ctx.accounts.market, market_key, outcome, now)?;
    let bond = ctx.accounts.bond_vault.amount;
    let auth_bump = ctx.accounts.proposal.auth_bump;
    let seeds: &[&[u8]] = &[OPT_BOND_AUTHORITY_SEED, market_key.as_ref(), &[auth_bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bond_vault.to_account_info(),
                to: ctx.accounts.proposer_ata.to_account_info(),
                authority: ctx.accounts.bond_authority.to_account_info(),
            },
            &[seeds],
        ),
        bond,
    )?;

    let p = &mut ctx.accounts.proposal;
    p.resolved = true;
    emit!(ProposalFinalized {
        market: market_key,
        outcome,
        ts: now,
    });
    Ok(())
}

// ─── opt_arbitrate ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct OptArbitrate<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        constraint = proposal.market == market.key() @ SoothCoreError::AmmStateMarketMismatch,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [OPT_PROPOSAL_SEED, market.key().as_ref()],
        bump = proposal.bump,
    )]
    pub proposal: Box<Account<'info, OptimisticProposal>>,

    #[account(
        mut,
        seeds = [OPT_BOND_VAULT_SEED, market.key().as_ref()],
        bump = proposal.vault_bump,
    )]
    pub bond_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: seeds-verified vault authority.
    #[account(
        seeds = [OPT_BOND_AUTHORITY_SEED, market.key().as_ref()],
        bump = proposal.auth_bump,
    )]
    pub bond_authority: UncheckedAccount<'info>,

    /// Both bonds land here; the handler proves it belongs to the winner.
    #[account(mut, token::mint = bond_vault.mint)]
    pub winner_ata: Box<Account<'info, TokenAccount>>,

    /// The arbiter is the adjudicator DESIGNATED AT CREATION
    /// (`Market.adjudicator`) — the fallback court every market names before
    /// it opens, which is what makes it unowned by either bonded side.
    #[account(constraint = arbiter.key() == market.adjudicator @ SoothCoreError::OptNotArbiter)]
    pub arbiter: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn arbitrate(ctx: Context<OptArbitrate>, outcome: u8) -> Result<()> {
    require_outcome(outcome)?;
    let now = Clock::get()?.unix_timestamp;
    {
        let p = &ctx.accounts.proposal;
        require!(!p.resolved, SoothCoreError::OptAlreadyResolved);
        require!(p.is_challenged(), SoothCoreError::OptNotChallenged);
    }

    // The zero-sum core: agree with the proposer and their assertion stands,
    // their bond doubles; any other ruling and the challenger takes the pot.
    // An INVALID ruling against a YES/NO proposal sides with the challenger —
    // "this question was never resolvable" is exactly what a challenge of an
    // overconfident assertion claims.
    let p_outcome = ctx.accounts.proposal.outcome;
    let winner = if outcome == p_outcome {
        ctx.accounts.proposal.proposer
    } else {
        ctx.accounts.proposal.challenger
    };
    require!(
        ctx.accounts.winner_ata.owner == winner,
        SoothCoreError::OptWrongRecipient
    );

    let market_key = ctx.accounts.market.key();
    settle_market(&mut ctx.accounts.market, market_key, outcome, now)?;

    let pot = ctx.accounts.bond_vault.amount;
    let auth_bump = ctx.accounts.proposal.auth_bump;
    let seeds: &[&[u8]] = &[OPT_BOND_AUTHORITY_SEED, market_key.as_ref(), &[auth_bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bond_vault.to_account_info(),
                to: ctx.accounts.winner_ata.to_account_info(),
                authority: ctx.accounts.bond_authority.to_account_info(),
            },
            &[seeds],
        ),
        pot,
    )?;

    let p = &mut ctx.accounts.proposal;
    p.resolved = true;
    emit!(ChallengeArbitrated {
        market: market_key,
        arbiter: ctx.accounts.arbiter.key(),
        outcome,
        winner,
        pot,
        ts: now,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn market_with(lifecycle: MarketLifecycle) -> Market {
        Market {
            market_id: [7u8; 16],
            creator: Pubkey::new_unique(),
            adjudicator: Pubkey::new_unique(),
            question_hash: [0u8; 32],
            vault_book: Pubkey::new_unique(),
            vault_amm: Pubkey::new_unique(),
            lock_vault: Pubkey::new_unique(),
            start_time: 0,
            deadline: 1_000,
            lifecycle,
            winning_outcome: 0,
            bump: 0,
            vault_authority_bump: 0,
            lock_authority_bump: 0,
            book_enabled: false,
            is_dismissed: false,
            _reserved: [0u8; 96],
        }
    }

    #[test]
    fn settle_market_walks_open_locked_settled() {
        let mut m = market_with(MarketLifecycle::Open);
        let did = settle_market(&mut m, Pubkey::new_unique(), OUTCOME_YES, 2_000).unwrap();
        assert!(did);
        assert!(matches!(m.lifecycle, MarketLifecycle::Settled));
        assert_eq!(m.winning_outcome, OUTCOME_YES);
    }

    #[test]
    fn settle_market_is_a_noop_when_already_settled() {
        let mut m = market_with(MarketLifecycle::Settled);
        m.winning_outcome = OUTCOME_NO;
        let did = settle_market(&mut m, Pubkey::new_unique(), OUTCOME_YES, 2_000).unwrap();
        assert!(!did, "another path won the race; the bond flow must not re-rule");
        assert_eq!(m.winning_outcome, OUTCOME_NO);
    }

    #[test]
    fn settle_market_noops_on_a_dismissed_market_so_bonds_still_flow() {
        let mut m = market_with(MarketLifecycle::Open);
        m.is_dismissed = true;
        let did = settle_market(&mut m, Pubkey::new_unique(), OUTCOME_YES, 2_000).unwrap();
        assert!(!did, "dismissal is terminal; the bond payout must not be");
        assert!(matches!(m.lifecycle, MarketLifecycle::Open));
    }
}
