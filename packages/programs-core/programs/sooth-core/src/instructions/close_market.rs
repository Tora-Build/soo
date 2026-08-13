//! `close_market` — reclaim a finished market's rent, without enabling
//! resurrection.
//!
//! ## Why the Market account is NOT deleted
//!
//! Every per-market PDA — `AmmState`, the book, the fee pools, and every
//! user's `Position` — derives from `market_id`, and `market_id` is a
//! caller-supplied argument to `create_market`. If closing a market returned
//! the Market account to the system program, `create_market` could be called
//! again with the same id: the new market would land at the same address, and
//! every surviving `Position` from the OLD market would deserialize cleanly
//! against the NEW one. A trader whose 700 losing shares expired worthless
//! could re-create the id, seed a thin market, and sell those shares into
//! other people's fresh collateral.
//!
//! So the Market account stays alive as a TOMBSTONE: shrunk to 8 bytes,
//! discriminator overwritten with a marker that is not any Anchor account's,
//! rent above the 8-byte minimum refunded. `create_market`'s `init` fails on
//! it (the account exists), and every other instruction that loads
//! `Account<Market>` fails its discriminator check — the tombstone poisons
//! the whole id, which is exactly the point. Cost: ~0.001 SOL per market
//! stays locked forever, out of ~0.017 reclaimed.
//!
//! ## Why the preconditions are balances, not time
//!
//! There is no `settled_at` on chain, so "the claim window has passed" is not
//! provable. What IS provable is that nobody is owed anything: every claim a
//! user can make — winner redemption, seat credit, resting-order escrow,
//! sell-lock, accrued fees — is paid from one of the five token accounts this
//! instruction requires to be EMPTY. Zero balances mean every remaining claim
//! is a claim on nothing, so closing strands no value. A market that cannot
//! reach zero (an absent maker's resting escrow, an unclaimed lock) simply
//! cannot be closed; that is the honest outcome, not a bug.
//!
//! The book, when it exists, must also carry no live orders and no seat with
//! net exposure or credit. `vault_book == 0` already implies those are
//! worthless, but if they are nonzero over an empty vault something upstream
//! was insolvent — and destroying the ledger that proves it is the wrong
//! response to that discovery.
//!
//! ## Who
//!
//! The creator signs and receives the rent — they paid it at creation. The
//! lamport destinations are fixed by that same constraint, so there is
//! nothing here for a third party to redirect.
//!
//! Not closeable, documented rather than hidden: the LP mint. Classic SPL
//! mints have no close authority, so its 0.0015 SOL is stranded by SPL's own
//! rules, not ours.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount};

use crate::book::account::load_book;
use crate::book::arena::{as_seat, NIL};
use crate::error::SoothCoreError;
use crate::events::MarketClosed;
use crate::state::{AmmState, Market};

/// Written over the Market account's discriminator on close. Deliberately not
/// a hash of any account name, so no Anchor account type will ever match it.
pub const MARKET_TOMBSTONE: [u8; 8] = *b"MKTCLOSD";

#[derive(Accounts)]
#[instruction(market_id: [u8; 16])]
pub struct CloseMarket<'info> {
    /// CHECK: seeds bind this to the market_id; the handler verifies the
    /// program owns it and deserializes it as a `Market` manually. It is
    /// deliberately NOT `Account<Market>`: Anchor would re-serialize the full
    /// struct on exit, and this handler shrinks the account to 8 bytes.
    #[account(mut, seeds = [b"market", market_id.as_ref()], bump)]
    pub market: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"amm", market_id.as_ref()],
        bump = amm_state.bump,
        close = creator,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// The book arena, for graduated markets. Optional because a market that
    /// never graduated never allocated one.
    ///
    /// CHECK: seeds bind it; the handler verifies emptiness before draining
    /// its lamports manually (it is a raw zero-copy account, not an Anchor
    /// `Account`, so `close =` cannot apply).
    #[account(mut, seeds = [b"book", market_id.as_ref()], bump)]
    pub book: Option<UncheckedAccount<'info>>,

    // ── The five token accounts that back every possible claim ──────────
    //
    // Each must hold ZERO. The addresses are pinned in the handler against
    // the fields the Market account itself recorded at creation, so the
    // caller cannot substitute empty decoys for funded vaults.
    #[account(mut)]
    pub vault_book: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_amm: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub lock_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, seeds = [b"fee_pool_amm", market_id.as_ref()], bump)]
    pub fee_pool_amm: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"fee_pool_book", market_id.as_ref()], bump)]
    pub fee_pool_book: Box<Account<'info, TokenAccount>>,

    // ── Signer-only PDAs that own the token accounts above ───────────────
    /// CHECK: signer-only PDA; derivation is the check.
    #[account(seeds = [b"vault", market_id.as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: signer-only PDA; derivation is the check.
    #[account(seeds = [b"lock", market_id.as_ref()], bump)]
    pub lock_authority: UncheckedAccount<'info>,
    /// CHECK: signer-only PDA; derivation is the check.
    #[account(seeds = [b"fee_pool_authority"], bump)]
    pub fee_pool_authority: UncheckedAccount<'info>,

    /// The market's creator — verified against the Market account in the
    /// handler. Signs, and receives every reclaimed lamport.
    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CloseMarket>, market_id: [u8; 16]) -> Result<()> {
    // ── Deserialize and verify the Market manually ───────────────────────
    let market_info = ctx.accounts.market.to_account_info();
    require!(
        market_info.owner == &crate::ID,
        SoothCoreError::MarketNotClosable
    );
    let market: Market = {
        let data = market_info.try_borrow_data()?;
        Market::try_deserialize(&mut &data[..])
            .map_err(|_| error!(SoothCoreError::MarketNotClosable))?
    };
    require!(market.market_id == market_id, SoothCoreError::MarketNotClosable);
    require_keys_eq!(
        market.creator,
        ctx.accounts.creator.key(),
        SoothCoreError::Unauthorized
    );

    // Finished means settled, or dismissed during its trial. An Open or
    // Locked market still owes its future to traders.
    require!(
        market.is_settled() || ctx.accounts.amm_state.is_dismissed,
        SoothCoreError::MarketNotClosable
    );

    // ── Pin the vaults to what the market recorded at creation ───────────
    require_keys_eq!(
        ctx.accounts.vault_book.key(),
        market.vault_book,
        SoothCoreError::VaultAuthorityMismatch
    );
    require_keys_eq!(
        ctx.accounts.vault_amm.key(),
        market.vault_amm,
        SoothCoreError::VaultAuthorityMismatch
    );
    require_keys_eq!(
        ctx.accounts.lock_vault.key(),
        market.lock_vault,
        SoothCoreError::VaultAuthorityMismatch
    );

    // ── Nothing may be owed ──────────────────────────────────────────────
    require!(ctx.accounts.vault_book.amount == 0, SoothCoreError::VaultNotEmpty);
    require!(ctx.accounts.vault_amm.amount == 0, SoothCoreError::VaultNotEmpty);
    require!(ctx.accounts.lock_vault.amount == 0, SoothCoreError::VaultNotEmpty);
    require!(
        ctx.accounts.fee_pool_amm.amount == 0,
        SoothCoreError::FeePoolNotEmpty
    );
    require!(
        ctx.accounts.fee_pool_book.amount == 0,
        SoothCoreError::FeePoolNotEmpty
    );

    // ── The book, if it exists, must be inert ────────────────────────────
    if let Some(book_acc) = &ctx.accounts.book {
        let info = book_acc.to_account_info();
        if info.owner == &crate::ID && info.data_len() > 0 {
            {
                let mut data = info.try_borrow_mut_data()?;
                let book = load_book(&mut data)
                    .map_err(|_| error!(SoothCoreError::BookNotEmpty))?;
                require!(
                    book.header.order_count == 0,
                    SoothCoreError::BookNotEmpty
                );
                // Walk the seat list. `vault_book == 0` already made any
                // remaining credit worthless, but a nonzero credit over an
                // empty vault is evidence of insolvency, and this ledger is
                // the only record of it. Refuse to destroy it.
                let mut idx = book.header.seats_head;
                while idx != NIL {
                    let node = book
                        .node(idx)
                        .map_err(|_| error!(SoothCoreError::BookNotEmpty))?;
                    let seat = as_seat(&node);
                    require!(
                        seat.net == 0 && seat.credit == 0,
                        SoothCoreError::BookNotEmpty
                    );
                    idx = node.next;
                }
            }
        }
    }

    // ── Close the five token accounts (SPL requires zero balances) ───────
    let (vb, lb, fb) = (
        ctx.bumps.vault_authority,
        ctx.bumps.lock_authority,
        ctx.bumps.fee_pool_authority,
    );
    let vault_seeds: &[&[u8]] = &[b"vault", market_id.as_ref(), &[vb]];
    let lock_seeds: &[&[u8]] = &[b"lock", market_id.as_ref(), &[lb]];
    let fee_seeds: &[&[u8]] = &[b"fee_pool_authority", &[fb]];

    fn close_ta<'info>(
        token_program: &Program<'info, Token>,
        destination: AccountInfo<'info>,
        acct: AccountInfo<'info>,
        authority: AccountInfo<'info>,
        seeds: &[&[u8]],
    ) -> Result<()> {
        token::close_account(CpiContext::new_with_signer(
            token_program.to_account_info(),
            CloseAccount {
                account: acct,
                destination,
                authority,
            },
            &[seeds],
        ))
    }
    let tp = &ctx.accounts.token_program;
    let dest = ctx.accounts.creator.to_account_info();
    close_ta(
        tp,
        dest.clone(),
        ctx.accounts.vault_book.to_account_info(),
        ctx.accounts.vault_authority.to_account_info(),
        vault_seeds,
    )?;
    close_ta(
        tp,
        dest.clone(),
        ctx.accounts.vault_amm.to_account_info(),
        ctx.accounts.vault_authority.to_account_info(),
        vault_seeds,
    )?;
    close_ta(
        tp,
        dest.clone(),
        ctx.accounts.lock_vault.to_account_info(),
        ctx.accounts.lock_authority.to_account_info(),
        lock_seeds,
    )?;
    close_ta(
        tp,
        dest.clone(),
        ctx.accounts.fee_pool_amm.to_account_info(),
        ctx.accounts.fee_pool_authority.to_account_info(),
        fee_seeds,
    )?;
    close_ta(
        tp,
        dest.clone(),
        ctx.accounts.fee_pool_book.to_account_info(),
        ctx.accounts.fee_pool_authority.to_account_info(),
        fee_seeds,
    )?;

    // ── Reclaim the book's rent ─────────────────────────────────────────
    //
    // AFTER the CPIs above, deliberately: the runtime verifies the lamport-
    // sum invariant at every CPI boundary, and a manual lamport move made
    // before `token::close_account` trips it ("sum of account balances before
    // and after instruction do not match"). All hand-rolled lamport motion
    // happens once no further CPI will run.
    let mut book_lamports_reclaimed: u64 = 0;
    if let Some(book_acc) = &ctx.accounts.book {
        let info = book_acc.to_account_info();
        if info.owner == &crate::ID && info.data_len() > 0 {
            // Raw program-owned account: drain lamports and hand the buffer
            // back. Zero data first so a same-slot reader cannot see a live-
            // looking book on a dead account.
            let mut data = info.try_borrow_mut_data()?;
            data.fill(0);
            drop(data);
            let lam = info.lamports();
            book_lamports_reclaimed = lam;
            **info.try_borrow_mut_lamports()? = 0;
            **ctx
                .accounts
                .creator
                .to_account_info()
                .try_borrow_mut_lamports()? += lam;
        }
    }


    // ── Tombstone the Market ─────────────────────────────────────────────
    // Shrink to 8 bytes, stamp the marker, refund the difference. The
    // account survives at rent-exempt minimum so `init` can never reuse the
    // address — see the module docs for why full deletion is an exploit.
    let keep = Rent::get()?.minimum_balance(MARKET_TOMBSTONE.len());
    let have = market_info.lamports();
    let refund = have.saturating_sub(keep);

    market_info.realloc(MARKET_TOMBSTONE.len(), false)?;
    {
        let mut data = market_info.try_borrow_mut_data()?;
        data.copy_from_slice(&MARKET_TOMBSTONE);
    }
    **market_info.try_borrow_mut_lamports()? = keep;
    **ctx
        .accounts
        .creator
        .to_account_info()
        .try_borrow_mut_lamports()? += refund;

    emit!(MarketClosed {
        market: market_info.key(),
        market_id,
        creator: ctx.accounts.creator.key(),
        // Token-account and AmmState rent arrive via CPI / Anchor close and
        // are not summed here; this records the two manual reclaims.
        market_rent_reclaimed: refund,
        book_rent_reclaimed: book_lamports_reclaimed,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
