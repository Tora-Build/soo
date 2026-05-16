//! `sooth_core` — the Sooth Protocol program.
//!
//! A single Anchor program covering market lifecycle, the LMSR AMM, the CLOB,
//! LP/launchpad flows, and adjudication. Subsystems call each other as plain
//! Rust functions, not CPIs. Resolution authority is a per-market
//! `AdjudicatorEntry` PDA.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

declare_id!("BgcooFgTuDQdoQkjLrZNRM6zM4Bu9bnAEenqdKjjR25W");

pub mod bitmap;
pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod matching;
pub mod math;
pub mod state;

pub use instructions::*;

#[program]
pub mod sooth_core {
    use super::*;
    use crate::instructions::attest_outcome;
    use crate::instructions::buy;
    use crate::instructions::cancel;
    use crate::instructions::cancel_by_id;
    use crate::instructions::claim_refund;
    use crate::instructions::claim_unlocked;
    use crate::instructions::close_book_side;
    use crate::instructions::compact_book_side;
    use crate::instructions::create_market;
    use crate::instructions::dismiss_market;
    use crate::instructions::dispute;
    use crate::instructions::distribute_fees;
    use crate::instructions::distribute_fees_legacy;
    use crate::instructions::init_market_fee_pool;
    use crate::instructions::initialize_amm_state;
    use crate::instructions::lock_for_resolution;
    use crate::instructions::merge_complete_set;
    use crate::instructions::merge_complete_set_for_orderbook;
    use crate::instructions::mint_complete_set;
    use crate::instructions::mint_complete_set_for_orderbook;
    use crate::instructions::mint_complete_set_to_program_owned;
    use crate::instructions::pause;
    use crate::instructions::redeem;
    use crate::instructions::redeem_from_program_owned;
    use crate::instructions::redeem_lp;
    use crate::instructions::redeem_orderbook;
    use crate::instructions::register_adjudicator;
    use crate::instructions::request_lock;
    use crate::instructions::seed_lp;
    use crate::instructions::sell_positions;
    use crate::instructions::settle;
    use crate::instructions::trade_positions;
    use crate::instructions::unpause;

    // ── Protocol lifecycle ────────────────────────────────────────────────────

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        args: InitializeProtocolArgs,
    ) -> Result<()> {
        initialize_protocol::handler(ctx, args)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        pause::handler(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        unpause::handler(ctx)
    }

    // ── Market creation ───────────────────────────────────────────────────────

    pub fn create_market(
        ctx: Context<CreateMarket>,
        args: CreateMarketArgs,
    ) -> Result<()> {
        create_market::handler(ctx, args)
    }

    pub fn initialize_amm_state(
        ctx: Context<InitializeAmmState>,
        args: InitializeAmmStateArgs,
    ) -> Result<()> {
        initialize_amm_state::handler(ctx, args)
    }

    // ── Fee infrastructure ────────────────────────────────────────────────────

    pub fn init_market_fee_pool(
        ctx: Context<InitMarketFeePool>,
    ) -> Result<()> {
        init_market_fee_pool::handler(ctx)
    }

    pub fn distribute_fees(ctx: Context<DistributeFees>) -> Result<()> {
        distribute_fees::handler(ctx)
    }

    pub fn distribute_fees_legacy(
        ctx: Context<DistributeFeesLegacy>,
    ) -> Result<()> {
        distribute_fees_legacy::handler(ctx)
    }

    // ── LP lifecycle ──────────────────────────────────────────────────────────

    pub fn seed_lp(
        ctx: Context<SeedLp>,
        args: SeedLpArgs,
    ) -> Result<()> {
        seed_lp::handler(ctx, args)
    }

    pub fn redeem_lp(ctx: Context<RedeemLp>, lp_amount: u64) -> Result<()> {
        redeem_lp::handler(ctx, lp_amount)
    }

    // ── Adjudicator ───────────────────────────────────────────────────────────

    pub fn register_adjudicator(
        ctx: Context<RegisterAdjudicator>,
        authority: Pubkey,
    ) -> Result<()> {
        register_adjudicator::handler(ctx, authority)
    }

    pub fn request_lock(ctx: Context<RequestLock>) -> Result<()> {
        request_lock::handler(ctx)
    }

    pub fn attest_outcome(
        ctx: Context<AttestOutcome>,
        winning_outcome: u8,
    ) -> Result<()> {
        attest_outcome::handler(ctx, winning_outcome)
    }

    pub fn dispute(ctx: Context<Dispute>, new_outcome: u8) -> Result<()> {
        dispute::handler(ctx, new_outcome)
    }

    pub fn settle(ctx: Context<Settle>, winning_outcome: u8) -> Result<()> {
        settle::handler(ctx, winning_outcome)
    }

    // ── Complete sets ─────────────────────────────────────────────────────────

    pub fn mint_complete_set(
        ctx: Context<MintCompleteSet>,
        amount: u64,
    ) -> Result<()> {
        mint_complete_set::handler(ctx, amount)
    }

    pub fn mint_complete_set_for_orderbook(
        ctx: Context<MintCompleteSetForOrderbook>,
        amount: u64,
    ) -> Result<()> {
        mint_complete_set_for_orderbook::handler(ctx, amount)
    }

    pub fn mint_complete_set_to_program_owned(
        ctx: Context<MintCompleteSetToProgramOwned>,
        amount: u64,
    ) -> Result<()> {
        mint_complete_set_to_program_owned::handler(ctx, amount)
    }

    pub fn merge_complete_set(
        ctx: Context<MergeCompleteSet>,
        amount: u64,
    ) -> Result<()> {
        merge_complete_set::handler(ctx, amount)
    }

    pub fn merge_complete_set_for_orderbook(
        ctx: Context<MergeCompleteSetForOrderbook>,
        amount: u64,
    ) -> Result<()> {
        merge_complete_set_for_orderbook::handler(ctx, amount)
    }

    // ── AMM ───────────────────────────────────────────────────────────────────

    pub fn trade_positions(
        ctx: Context<TradePositions>,
        outcome: u8,
        delta_shares: i128,
        max_cost_wad: u128,
    ) -> Result<()> {
        trade_positions::handler(ctx, outcome, delta_shares, max_cost_wad)
    }

    pub fn sell_positions(
        ctx: Context<SellPositions>,
        outcome: u8,
        delta_shares: i128,
        min_proceeds_wad: u128,
        lock_nonce: u64,
    ) -> Result<()> {
        sell_positions::handler(ctx, outcome, delta_shares, min_proceeds_wad, lock_nonce)
    }

    pub fn claim_unlocked(ctx: Context<ClaimUnlocked>) -> Result<()> {
        claim_unlocked::handler(ctx)
    }

    pub fn dismiss_market(ctx: Context<DismissMarket>) -> Result<()> {
        dismiss_market::handler(ctx)
    }

    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        claim_refund::handler(ctx)
    }

    // ── Settlement & redeem ───────────────────────────────────────────────────

    pub fn lock_for_resolution(
        ctx: Context<LockForResolution>,
    ) -> Result<()> {
        lock_for_resolution::handler(ctx)
    }

    pub fn redeem(ctx: Context<Redeem>) -> Result<()> {
        redeem::handler(ctx)
    }

    pub fn redeem_orderbook(ctx: Context<RedeemOrderbook>) -> Result<()> {
        redeem_orderbook::handler(ctx)
    }

    pub fn redeem_from_program_owned(
        ctx: Context<RedeemFromProgramOwned>,
    ) -> Result<()> {
        redeem_from_program_owned::handler(ctx)
    }

    // ── CLOB ──────────────────────────────────────────────────────────────────

    pub fn buy<'info>(
        ctx: Context<'_, '_, '_, 'info, BuyOrder<'info>>,
        side: u8,
        tick: u16,
        amount: u128,
        escrow: bool,
        match_limit: u32,
    ) -> Result<()> {
        buy::handler(ctx, side, tick, amount, escrow, match_limit)
    }

    pub fn cancel(ctx: Context<CancelOrder>, side: u8, tick: u16) -> Result<()> {
        cancel::handler(ctx, side, tick)
    }

    pub fn cancel_by_id(
        ctx: Context<CancelByIdOrder>,
        order_id: u64,
        side: u8,
        tick: u16,
    ) -> Result<()> {
        cancel_by_id::handler(ctx, order_id, side, tick)
    }

    pub fn close_book_side(ctx: Context<CloseBookSide>) -> Result<()> {
        close_book_side::handler(ctx)
    }

    pub fn compact_book_side(
        ctx: Context<CompactBookSide>,
        max_drops: u8,
    ) -> Result<()> {
        compact_book_side::handler(ctx, max_drops)
    }
}
