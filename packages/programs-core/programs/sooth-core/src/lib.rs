//! `sooth_core` — the Sooth Protocol program.
//!
//! A single Anchor program covering market lifecycle, the LMSR AMM, the CLOB,
//! LP/launchpad flows, and adjudication. Subsystems call each other as plain
//! Rust functions, not CPIs. Resolution authority is a per-market
//! `AdjudicatorEntry` PDA.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

declare_id!("EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw");

// ── 256 KB bump allocator ────────────────────────────────────────────────
//
// Solana's default allocator hardcodes a 32 KB heap and never frees, so
// allocations accumulate for the whole instruction. The multi-fill `buy`
// path needs roughly 5 KB + 8 KB per fill, which capped matching at THREE
// fills: a 4-fill buy died with "memory allocation failed, out of memory" at
// only ~226k CU (16% of budget) and ~19 writable accounts (of ~32). Neither
// compute nor the account budget was binding — the heap was.
//
// This mirrors solana_program's own BumpAllocator (down-bumping, never
// frees) over a 256 KB region, the maximum `request_heap_frame` permits.
// The default allocator is suppressed by the `custom-heap` feature.
//
// ⚠️ CALLER CONTRACT: every transaction must prepend
// `ComputeBudgetInstruction::request_heap_frame(256 * 1024)`. The runtime
// only maps the larger region when asked, and this allocator hands out
// addresses from the TOP of that region — so without the frame the very
// first allocation points outside mapped memory and the program aborts with
// "Access violation in heap section". The mapped size cannot be queried at
// runtime, so this cannot be detected and reported nicely.
//
// Because sooth_core is a single merged program, this applies to EVERY
// instruction, not just multi-fill buys. `SolanaChainAdapter` prepends the
// frame on all paths; hand-rolled callers must do the same.
#[cfg(all(feature = "custom-heap", target_os = "solana"))]
#[global_allocator]
static SOOTH_CORE_ALLOC: BumpAllocator256 = BumpAllocator256;

/// Heap size this program's allocator assumes, and therefore the exact value
/// callers must pass to `request_heap_frame`.
pub const SOOTH_CORE_HEAP_LEN: usize = 256 * 1024;

#[cfg(all(feature = "custom-heap", target_os = "solana"))]
struct BumpAllocator256;

#[cfg(all(feature = "custom-heap", target_os = "solana"))]
unsafe impl core::alloc::GlobalAlloc for BumpAllocator256 {
    #[inline]
    unsafe fn alloc(&self, layout: core::alloc::Layout) -> *mut u8 {
        const HEAP_START: usize = 0x3_0000_0000;
        // The first machine word of the region holds the bump cursor.
        let pos_ptr = HEAP_START as *mut usize;
        let mut pos = *pos_ptr;
        if pos == 0 {
            pos = HEAP_START + SOOTH_CORE_HEAP_LEN;
        }
        pos = pos.saturating_sub(layout.size());
        pos &= !(layout.align().wrapping_sub(1));
        // Refuse to hand back the cursor slot itself.
        if pos < HEAP_START + core::mem::size_of::<*mut u8>() {
            return core::ptr::null_mut();
        }
        *pos_ptr = pos;
        pos as *mut u8
    }

    #[inline]
    unsafe fn dealloc(&self, _: *mut u8, _: core::alloc::Layout) {}
}

pub mod bitmap;
pub mod book;
pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;
pub mod zk;

pub use instructions::*;

#[program]
pub mod sooth_core {
    use super::*;
    use crate::instructions::attest_outcome;
    use crate::instructions::attest_outcome_zk;
    use crate::instructions::book_init;
    use crate::instructions::book_ops;
    use crate::instructions::book_place;
    use crate::instructions::claim_refund;
    use crate::instructions::claim_unlocked;
    use crate::instructions::create_market;
    use crate::instructions::dismiss_market;
    use crate::instructions::dispute;
    use crate::instructions::distribute_fees;
    use crate::instructions::distribute_fees_book;
    use crate::instructions::init_market_fee_pool;
    use crate::instructions::lock_for_resolution;
    use crate::instructions::pause;
    use crate::instructions::reclaim_subsidy;
    use crate::instructions::redeem_amm_position;
    use crate::instructions::redeem_lp;
    use crate::instructions::register_adjudicator;
    use crate::instructions::register_zk_adjudicator;
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

    pub fn create_market(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
        create_market::handler(ctx, args)
    }

    // ── Fee infrastructure ────────────────────────────────────────────────────

    pub fn init_market_fee_pool(ctx: Context<InitMarketFeePool>) -> Result<()> {
        init_market_fee_pool::handler(ctx)
    }

    pub fn distribute_fees_amm(ctx: Context<DistributeFeesAmm>) -> Result<()> {
        distribute_fees::handler(ctx)
    }

    pub fn distribute_fees_book(ctx: Context<DistributeFeesBook>) -> Result<()> {
        distribute_fees_book::handler(ctx)
    }

    // ── LP lifecycle ──────────────────────────────────────────────────────────

    pub fn seed_lp(ctx: Context<SeedLp>, args: SeedLpArgs) -> Result<()> {
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

    /// Register a per-market adjudicator that resolves from a Primus zkTLS
    /// attestation rather than a human signature. Separate from
    /// `register_adjudicator` so the manual path is untouched, and so zk mode
    /// is fixed at creation rather than switchable under a live market.
    pub fn register_zk_adjudicator(
        ctx: Context<RegisterZkAdjudicator>,
        args: RegisterZkAdjudicatorArgs,
    ) -> Result<()> {
        register_zk_adjudicator::handler(ctx, args)
    }

    pub fn request_lock(ctx: Context<RequestLock>) -> Result<()> {
        request_lock::handler(ctx)
    }

    pub fn attest_outcome(ctx: Context<AttestOutcome>, winning_outcome: u8) -> Result<()> {
        attest_outcome::handler(ctx, winning_outcome)
    }

    /// Record an outcome derived from a verified Primus zkTLS attestation.
    /// Permissionless: the attestation carries its own authority. Like
    /// `attest_outcome` it records only — `settle` still finalizes after the
    /// veto window, so `dispute` remains available against a bad attestation.
    pub fn attest_outcome_zk(
        ctx: Context<AttestOutcomeZk>,
        attestation: crate::zk::ZkAttestation,
    ) -> Result<()> {
        attest_outcome_zk::handler(ctx, attestation)
    }

    pub fn dispute(ctx: Context<Dispute>, new_outcome: u8) -> Result<()> {
        dispute::handler(ctx, new_outcome)
    }

    /// Finalize an attested market. Permissionless once the veto window has
    /// closed; the outcome comes from the `AdjudicatorEntry`, not the caller.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        settle::handler(ctx)
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

    pub fn sweep_residual(ctx: Context<SweepResidual>) -> Result<()> {
        instructions::sweep_residual::handler(ctx)
    }

    pub fn close_market(ctx: Context<CloseMarket>, market_id: [u8; 16]) -> Result<()> {
        instructions::close_market::handler(ctx, market_id)
    }

    pub fn dismiss_market(ctx: Context<DismissMarket>) -> Result<()> {
        dismiss_market::handler(ctx)
    }

    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        claim_refund::handler(ctx)
    }

    // ── Settlement & redeem ───────────────────────────────────────────────────

    pub fn lock_for_resolution(ctx: Context<LockForResolution>) -> Result<()> {
        lock_for_resolution::handler(ctx)
    }

    /// Return the unspent LMSR subsidy to the creator after settlement.
    /// See `reclaim_subsidy`.
    pub fn reclaim_subsidy(ctx: Context<ReclaimSubsidy>) -> Result<()> {
        reclaim_subsidy::handler(ctx)
    }

    pub fn redeem_amm_position(ctx: Context<RedeemAmmPosition>) -> Result<()> {
        redeem_amm_position::handler(ctx)
    }

    /// Pay out a winning book seat position after settlement. See
    /// `redeem_book_seat`.
    pub fn redeem_book_seat(ctx: Context<RedeemBookSeat>) -> Result<()> {
        redeem_book_seat::handler(ctx)
    }

    // ── CLOB ──────────────────────────────────────────────────────────────────

    /// Place an order on the book. See `book_place` module docs.
    pub fn book_place(
        ctx: Context<BookPlace>,
        side: u8,
        limit_tick: u16,
        amount: u64,
        match_limit: u32,
        post_remainder: bool,
    ) -> Result<()> {
        book_place::handler(ctx, side, limit_tick, amount, match_limit, post_remainder)
    }

    /// Create the per-market book. See `book_init`.
    pub fn book_init(ctx: Context<BookInit>, initial_capacity: u16) -> Result<()> {
        book_init::init_handler(ctx, initial_capacity)
    }

    /// Extend the book toward `wanted_capacity`, one realloc step per call.
    pub fn book_grow(ctx: Context<BookGrow>, wanted_capacity: u16) -> Result<()> {
        book_init::grow_handler(ctx, wanted_capacity)
    }

    /// Cancel a resting book order; the escrow lands in the owner's seat
    /// credit. See `book_ops`.
    pub fn book_cancel(ctx: Context<BookCancel>, order_seq: u64) -> Result<()> {
        book_ops::cancel_handler(ctx, order_seq)
    }

    /// Move accumulated seat credit into the caller's wallet.
    pub fn book_withdraw(ctx: Context<BookWithdraw>) -> Result<()> {
        book_ops::withdraw_handler(ctx)
    }
}
